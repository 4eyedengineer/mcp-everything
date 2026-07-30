import { Injectable, Optional, NotFoundException } from '@nestjs/common';
import * as z from 'zod/v4';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { Conversation, PipelineRun } from '../database/entities';
import { PipelineState, PipelineStepName } from './types';
import { ResearchService } from './research.service';
import { ClarificationService } from './clarification.service';
import { RefinementService } from './refinement.service';
import { getPlatformContextPrompt } from './platform-context';
import { ErrorLoggingService } from '../logging/error-logging.service';
import { StructuredLoggerService } from '../logging/structured-logger.service';
import { AnthropicService } from '../ai/anthropic.service';
import { UserService } from '../user/user.service';

/**
 * Intent analysis output contract (enforced by the API's structured outputs).
 *
 * `scope` replaces the old 70-line regex `extractToolConstraints`: the model
 * reads the user's wording and reports the scope it implies. No pattern
 * matching, and it handles phrasings the regexes never could ("just the three
 * read endpoints", "nothing that writes").
 */
const IntentAnalysisSchema = z.object({
  intent: z.enum(['generate_mcp', 'clarify', 'research', 'help', 'unknown']),
  confidence: z.number(),
  githubUrl: z.string().nullable().optional(),
  missingInfo: z.array(z.string()).nullable().optional(),
  reasoning: z.string(),
  scope: z.object({
    requestedToolCount: z.number().nullable().optional(),
    requestedToolNames: z.array(z.string()).nullable().optional(),
    readOnlyOnly: z.boolean().nullable().optional(),
    scopeConstraint: z.string().nullable().optional(),
  }),
});

/**
 * Tool plan output contract.
 *
 * Parameters are described as a closed list of typed fields rather than a
 * free-form JSON-Schema blob so the structured-output schema stays strict; the
 * JSON Schema handed to the code generator is assembled here in code.
 */
const PlannedToolSchema = z.object({
  name: z.string(),
  description: z.string(),
  readOnly: z.boolean(),
  priority: z.enum(['high', 'medium', 'low']),
  estimatedComplexity: z.enum(['simple', 'moderate', 'complex']),
  parameters: z.array(
    z.object({
      name: z.string(),
      type: z.enum(['string', 'number', 'integer', 'boolean', 'object', 'array']),
      description: z.string(),
      required: z.boolean(),
      enumValues: z.array(z.string()).nullable().optional(),
      itemsType: z.enum(['string', 'number', 'integer', 'boolean', 'object']).nullable().optional(),
    }),
  ),
});

const ToolPlanSchema = z.object({
  serverName: z.string(),
  tools: z.array(PlannedToolSchema),
  steps: z.array(z.string()),
  estimatedComplexity: z.enum(['simple', 'moderate', 'complex']),
  rationale: z.string(),
  scopeNotes: z.string(),
});

type ToolPlan = z.infer<typeof ToolPlanSchema>;

/** Absolute ceiling on planned tools when the user gave no explicit count. */
const DEFAULT_MAX_TOOLS = 10;

/** Refinement iteration cap (mirrors RefinementService's own limit). */
const MAX_REFINEMENT_ITERATIONS = 5;

/**
 * An update handed to the SSE layer. `streamingUpdates` carries only the
 * entries produced since the previous yield.
 */
export type PipelineUpdate = Partial<PipelineState> & { conversationId: string };

/**
 * Generation Pipeline
 *
 * One explicit, observable, resumable pipeline:
 *
 *   analyzeIntent -> research -> planTools -> clarify -> refine (loop) -> persist
 *
 * Replaces the LangGraph state machine (which compiled without a checkpointer,
 * so multi-turn state never survived, and whose conditional edges mostly had
 * identical branches) and the 4-agent "ensemble" vote (whose consensus score was
 * a constant and whose merge step was commented out).
 *
 * Resumability: when the clarify step needs user input, the full state is
 * serialised into `conversations.state.pipeline`. The next message on the same
 * conversation resumes from that state - research is *not* re-run.
 *
 * Observability: every step writes a `pipeline_runs` row with status, timings
 * and input/output summaries.
 */
@Injectable()
export class GenerationPipeline {
  private readonly logger: StructuredLoggerService;
  private readonly generatedServersDir: string;

  /** Streaming entries produced since the last yield, keyed by state object. */
  private readonly pending = new WeakMap<
    PipelineState,
    Array<{ node: string; message: string; timestamp: Date }>
  >();

  constructor(
    @InjectRepository(Conversation)
    private readonly conversationRepo: Repository<Conversation>,
    @InjectRepository(PipelineRun)
    private readonly pipelineRunRepo: Repository<PipelineRun>,
    private readonly researchService: ResearchService,
    private readonly clarificationService: ClarificationService,
    private readonly refinementService: RefinementService,
    // Quota enforcement/recording for the generation entry (see `run()`)
    private readonly userService: UserService,
    // Single AI seam (models, retries, timeouts, telemetry)
    private readonly anthropic: AnthropicService,
    structuredLogger: StructuredLoggerService,
    private readonly configService: ConfigService,
    @Optional() private readonly errorLoggingService?: ErrorLoggingService,
  ) {
    this.logger = structuredLogger.setContext('GenerationPipeline');
    // In the production container image cwd is /app and the Dockerfile
    // provisions a writable /app/generated-servers - `../../generated-servers`
    // resolves outside of /app and is not writable by the nestjs user.
    this.generatedServersDir = this.configService.get<string>(
      'GENERATED_SERVERS_DIR',
      join(process.cwd(), 'generated-servers'),
    );
  }

  // ---------------------------------------------------------------------------
  // Entry points
  // ---------------------------------------------------------------------------

  /**
   * Resolve (loading or creating) the conversation for a session and return its
   * id.
   *
   * Exposed so callers (e.g. ChatController) can return the real conversation
   * UUID to the client before the pipeline finishes executing.
   */
  async ensureConversation(
    sessionId: string,
    conversationId?: string,
    userId?: string,
  ): Promise<string> {
    const conversation = await this.loadOrCreateConversation(sessionId, conversationId, userId);
    return conversation.id;
  }

  /**
   * Execute the pipeline for a user message.
   *
   * Resolves the conversation and persists the user's message before returning
   * the update stream, so ownership violations surface immediately rather than
   * on first iteration.
   */
  async execute(
    sessionId: string,
    userInput: string,
    conversationId?: string,
    userId?: string,
  ): Promise<AsyncGenerator<PipelineUpdate>> {
    const startTime = Date.now();

    try {
      // Load or create conversation (ownership enforced when userId is known)
      const conversation = await this.loadOrCreateConversation(sessionId, conversationId, userId);

      this.logger.log('Starting pipeline execution', {
        conversationId: conversation.id,
        sessionId,
        inputLength: userInput.length,
      });

      // Save user message to conversation immediately
      await this.saveMessageToConversation(conversation.id, {
        role: 'user',
        content: userInput,
        timestamp: new Date(),
      });

      // Reload conversation to get updated messages + any saved pipeline state
      const updated = await this.conversationRepo.findOne({ where: { id: conversation.id } });

      const saved = this.readSavedState(updated);
      const state: PipelineState = saved
        ? {
            ...saved,
            sessionId,
            conversationId: conversation.id,
            userId,
            messages: updated?.messages || [],
            userInput,
            needsUserInput: false,
            isComplete: false,
            error: undefined,
            clarificationNeeded: undefined,
            streamingUpdates: [],
            // A resumed run is its own run: pipeline_runs is the cross-turn
            // audit trail, executedSteps describes this turn.
            currentStep: 'planTools',
            executedSteps: [],
          }
        : {
            sessionId,
            conversationId: conversation.id,
            userId,
            messages: updated?.messages || [],
            userInput,
            currentStep: 'analyzeIntent',
            executedSteps: [],
            needsUserInput: false,
            isComplete: false,
            streamingUpdates: [],
          };

      if (saved) {
        // Record the user's answer against the open clarification round.
        const history = [...(state.clarificationHistory || [])];
        if (history.length > 0) {
          history[history.length - 1] = {
            ...history[history.length - 1],
            userResponses: userInput,
          };
          state.clarificationHistory = history;
        }
        this.logger.log('Resuming saved pipeline state (research will not be re-run)', {
          conversationId: conversation.id,
          clarificationRounds: history.length,
        });
      }

      return this.run(state, Boolean(saved));
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error(`Pipeline execution failed: ${error.message}`, error.stack, {
        conversationId,
        sessionId,
        duration,
      });
      await this.logError(error, 'execute', conversationId, { sessionId, userInput, duration });
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // The pipeline
  // ---------------------------------------------------------------------------

  private async *run(state: PipelineState, resumed: boolean): AsyncGenerator<PipelineUpdate> {
    try {
      if (!resumed) {
        // --- Step 1: analyzeIntent -----------------------------------------
        await this.step(state, 'analyzeIntent', state.userInput, () => this.analyzeIntent(state));
        yield this.snapshot(state);

        if (state.intent?.type === 'help') {
          await this.step(state, 'provideHelp', state.userInput, async () =>
            this.provideHelp(state),
          );
          yield* this.finish(state);
          return;
        }

        if (state.clarificationNeeded || state.intent?.type === 'unknown' || !state.intent) {
          // Not enough to act on - ask and wait for the next message.
          state.response = state.clarificationNeeded?.question || 'Could you provide more details?';
          state.needsUserInput = true;
          yield* this.pause(state);
          return;
        }

        // --- Quota gate ------------------------------------------------------
        // Deliberately placed here: after `analyzeIntent` (a single small-model
        // classification call - cheap) and before `research` (the first
        // expensive step - web search, GitHub API calls, and further LLM
        // calls through `planTools`/`refine`). Help and clarification-needed
        // replies above never reach this check, so they are never blocked by
        // quota. Silent (no pipeline_runs row, no progress message) when the
        // user is within quota so the normal path is unaffected; only the
        // denial is user-visible, delivered as a normal assistant response
        // through the same SSE `complete` event every other reply uses.
        const quota = await this.checkGenerationQuota(state);
        if (!quota.allowed) {
          state.response = quota.reason!;
          this.push(state, 'analyzeIntent', quota.reason!);
          yield* this.finish(state);
          return;
        }

        // --- Step 2: research ----------------------------------------------
        await this.step(state, 'research', state.userInput, () => this.research(state));
        yield this.snapshot(state);

        const confidence = state.researchPhase?.researchConfidence ?? 0;
        if (confidence <= 0.5) {
          state.clarificationNeeded = {
            question:
              'I could not gather enough reliable information about that. Could you tell me more ' +
              'about the API or service you want an MCP server for (a docs URL or repository ' +
              'link helps most)?',
            context: 'low_research_confidence',
          };
          state.response = state.clarificationNeeded.question;
          state.needsUserInput = true;
          yield* this.pause(state);
          return;
        }
      }

      // --- Step 3: planTools -------------------------------------------------
      // Re-run on resume: it is a single cheap call, and it is what lets the
      // user's clarification answers actually change the tool set.
      await this.step(
        state,
        'planTools',
        `research confidence ${(state.researchPhase?.researchConfidence ?? 0).toFixed(2)}`,
        () => this.planTools(state),
      );
      yield this.snapshot(state);

      // --- Step 4: clarify ---------------------------------------------------
      await this.step(
        state,
        'clarify',
        `${state.generationPlan?.toolsToGenerate.length ?? 0} planned tools`,
        () => this.clarify(state),
      );
      yield this.snapshot(state);

      if (state.needsUserInput && state.clarificationNeeded) {
        state.response = state.clarificationNeeded.question;
        yield* this.pause(state);
        return;
      }

      // --- Step 5: refine (loop) --------------------------------------------
      yield* this.refine(state);

      // --- Step 6: persist ---------------------------------------------------
      yield* this.finish(state);
    } catch (error) {
      this.logger.error(`Pipeline failed: ${error.message}`, error.stack, {
        conversationId: state.conversationId,
        step: state.currentStep,
      });
      await this.logError(error, `run:${state.currentStep}`, state.conversationId, {
        userInput: state.userInput,
      });

      const failedStep = state.currentStep;
      await this.step(state, 'handleError', `failed at ${failedStep}`, async () =>
        this.handleError(state, error, failedStep),
      );
      yield* this.finish(state);
    }
  }

  // ---------------------------------------------------------------------------
  // Steps
  // ---------------------------------------------------------------------------

  /**
   * Step: analyzeIntent
   *
   * Cheap classification on the small model. Also extracts the user's scope
   * constraints semantically (count, named tools, read-only) so the planner can
   * honour them.
   */
  private async analyzeIntent(state: PipelineState): Promise<string> {
    const prompt = `${getPlatformContextPrompt()}

**CRITICAL: When the user mentions "MCP", they ALWAYS mean "Model Context Protocol" (a protocol for LLMs), NEVER Minecraft, Merchant, or anything else.**

**Your Role**: Quickly determine user intent and proceed with confidence. Prefer reasonable defaults over asking questions.

**Common Intents:**
1. **generate_mcp**: User wants to create a Model Context Protocol (MCP) server - e.g., "create a Stripe MCP server" means create an MCP server for Stripe API
2. **research**: User wants to understand something (e.g., "how does the GitHub API work")
3. **clarify**: User is responding to a previous clarification request
4. **help**: User needs guidance on using the platform

**User Message:**
"${state.userInput}"

**Conversation Context:**
${state.messages
  .slice(-3)
  .map((m) => `${m.role}: ${m.content}`)
  .join('\n')}

**Task**: Determine primary intent with confidence. When the user mentions "MCP server" or "MCP" in any context, they mean Model Context Protocol server - a tool for extending LLM capabilities.

**Inference Guidelines:**
- If user mentions a service/API (Stripe, GitHub, etc.) + "MCP", they want a Model Context Protocol server for that service
- MCP = Model Context Protocol ONLY (not Minecraft, not Merchant anything)
- If user asks "how to" or "explain", intent is likely \`research\` or \`help\`
- Default to TypeScript unless user specifies another language
- Only flag missing info if it's CRITICAL and cannot be inferred

**Scope extraction** - read what the user actually asked for and report it in \`scope\`:
- \`requestedToolCount\`: the number of tools they asked for, if they said or implied one.
  "list posts, get post, list comments" implies 3. "with 2 tools" is 2. Null if unstated.
- \`requestedToolNames\`: the specific operations they named, in their words, normalised to
  snake_case tool names (e.g. ["list_posts", "get_post", "list_comments"]). Null if they
  did not enumerate operations.
- \`readOnlyOnly\`: true when they asked only for reads/queries/lookups, or explicitly said
  read-only / no writes / don't modify anything. A request phrased purely as "list X, get Y"
  is read-only.
- \`scopeConstraint\`: a one-line restatement of the scope limit in the user's own terms,
  or null when they set no limit.

Do NOT invent constraints the user did not express, and do NOT drop constraints they did.`;

    const analysis = await this.anthropic.completeStructured({
      prompt,
      schema: IntentAnalysisSchema,
      schemaName: 'IntentAnalysis',
      model: 'small',
      maxTokens: 2048,
      caller: 'pipeline.analyzeIntent',
    });

    const scope = analysis.scope || {};
    const requestedToolNames = scope.requestedToolNames?.length
      ? scope.requestedToolNames
      : undefined;
    const requestedToolCount = scope.requestedToolCount ?? requestedToolNames?.length ?? undefined;

    state.intent = {
      type: analysis.intent,
      confidence: analysis.confidence,
      reasoning: analysis.reasoning,
    };
    state.extractedData = { ...state.extractedData, githubUrl: analysis.githubUrl ?? undefined };
    state.requestedToolCount = requestedToolCount;
    state.requestedToolNames = requestedToolNames;
    state.maxToolCount = requestedToolCount ?? undefined;
    state.readOnlyOnly = scope.readOnlyOnly ?? undefined;
    state.scopeConstraint = scope.scopeConstraint ?? undefined;
    state.clarificationNeeded = analysis.missingInfo?.length
      ? {
          question: `I need more information: ${analysis.missingInfo.join(', ')}`,
          context: 'intent_analysis',
        }
      : undefined;

    let message = `Analyzed intent: ${analysis.intent} (confidence: ${analysis.confidence})`;
    if (requestedToolCount) {
      message += ` | Tool constraint: ${requestedToolCount} tools`;
      if (requestedToolNames?.length) {
        message += ` (${requestedToolNames.join(', ')})`;
      }
    }
    if (state.readOnlyOnly) {
      message += ' | read-only';
    }
    this.push(state, 'analyzeIntent', message);

    return message;
  }

  /**
   * Quota gate: does this user have monthly generation quota left?
   *
   * `state.userId` is unset when a caller runs the pipeline without an
   * authenticated user (only possible outside the production HTTP entry
   * point, which always supplies one via `@CurrentUser`) - treated as
   * allowed rather than failing closed against a user that cannot be looked
   * up.
   */
  private async checkGenerationQuota(
    state: PipelineState,
  ): Promise<{ allowed: boolean; reason?: string }> {
    if (!state.userId) {
      return { allowed: true };
    }

    try {
      return await this.userService.checkCanGenerate(state.userId);
    } catch (error) {
      // Quota lookup failing must never itself block generation.
      this.logger.warn(`Quota check failed for user ${state.userId}: ${error.message}`);
      return { allowed: true };
    }
  }

  /**
   * Record one unit of monthly quota usage for a successful generation.
   *
   * Called exactly once, from the `refine()` success branch - i.e. on
   * completion, never on attempt. Best-effort: a failure to record usage must
   * not turn an otherwise-successful generation into an error for the user.
   */
  private async recordSuccessfulGeneration(state: PipelineState): Promise<void> {
    if (!state.userId) {
      return;
    }

    try {
      await this.userService.incrementUsage(state.userId);
    } catch (error) {
      this.logger.warn(
        `Failed to record generation usage for user ${state.userId}: ${error.message}`,
      );
    }
  }

  /** Step: research - multi-source research via ResearchService. */
  private async research(state: PipelineState): Promise<string> {
    this.push(state, 'research', 'Starting comprehensive research phase...');

    state.researchPhase = await this.researchService.conductResearch(state);

    const summary = `Research complete: confidence ${state.researchPhase.researchConfidence.toFixed(2)}`;
    this.push(state, 'research', summary);
    return summary;
  }

  /**
   * Step: planTools
   *
   * One structured call that turns research findings into the concrete tool set
   * the refinement loop generates code from. Replaces the 4-agent ensemble,
   * whose voting was a constant and which inflated a 3-tool read-only request
   * into 10 tools including unrequested mutations.
   */
  private async planTools(state: PipelineState): Promise<string> {
    this.push(state, 'planTools', 'Planning MCP tool surface...');

    const research = state.researchPhase;
    const maxTools = state.maxToolCount ?? DEFAULT_MAX_TOOLS;

    const clarifications = (state.clarificationHistory || [])
      .filter((round) => round.userResponses)
      .map(
        (round, i) =>
          `Round ${i + 1}:\n  Asked: ${round.questions.map((q) => q.question).join(' | ')}\n  Answered: ${round.userResponses}`,
      )
      .join('\n');

    const prompt = `${getPlatformContextPrompt()}

**Your Role**: Decide exactly which MCP tools this server should expose. You are the
single planner - there is no committee to average your answer with, so be precise
and be disciplined about scope.

**User Request (verbatim)**:
"${state.userInput}"

**Scope the user set**:
${this.describeScope(state)}

**Research Summary**:
${research?.synthesizedPlan?.summary || 'No summary available'}

**Key Insights**:
${research?.synthesizedPlan?.keyInsights?.map((i) => `- ${i}`).join('\n') || '- None'}

**Recommended Approach**:
${research?.synthesizedPlan?.recommendedApproach || 'None'}

**Known Challenges**:
${research?.synthesizedPlan?.potentialChallenges?.map((c) => `- ${c}`).join('\n') || '- None'}

**API details found by research**:
${research?.webSearchFindings?.bestPractices?.map((p) => `- ${p}`).join('\n') || '- None'}

**Endpoints / documents found by research**:
${
  research?.webSearchFindings?.results
    ?.slice(0, 15)
    .map((r) => `- ${r.title}: ${r.snippet}`)
    .join('\n') || '- None'
}

**Repository signal** (when the input was a repo):
- Repository: ${state.extractedData?.githubUrl || 'n/a'}
- Language: ${research?.githubDeepDive?.basicInfo?.language || 'unknown'}
- API usage patterns found: ${research?.githubDeepDive?.apiUsagePatterns?.length || 0}
- Dependencies: ${
      Object.keys(research?.githubDeepDive?.dependencies || {})
        .slice(0, 10)
        .join(', ') || 'none'
    }

${clarifications ? `**Clarifications the user already answered** (these override earlier assumptions):\n${clarifications}\n` : ''}
**SCOPE RULES - these are hard requirements, not preferences**:
1. If the user enumerated operations, generate EXACTLY those and nothing else. Three named
   operations means exactly three tools. Do not add "obvious companions", CRUD siblings,
   search variants, batch helpers, health checks, or convenience wrappers.
2. If the user asked for read-only behaviour (or only named read operations), emit NO tool
   that creates, updates, deletes, uploads, or otherwise mutates remote state. Mark every
   tool \`readOnly: true\`.
3. If the user gave a count, match it exactly. Never exceed ${maxTools} tools under any
   circumstances.
4. If the user set no scope, choose the smallest set that genuinely covers their request
   (typically 3-7 tools), ordered by usefulness.
5. Name tools in snake_case. When the user named operations, keep their names.

**Quality rules**:
- Every tool must map to something research actually confirmed exists. Do not invent
  endpoints.
- Parameters: only the ones the operation needs. Mark required accurately. Prefer
  primitive types; use \`object\`/\`array\` only when the API genuinely takes structured input.
- \`steps\` should be the concrete implementation checklist for this server.
- \`rationale\` must explain the tool set: why each tool is present and, if the user set a
  scope, what you deliberately left out to honour it.
- \`scopeNotes\` must state how the user's scope constrained the plan (or "no scope
  constraint stated" when they set none).
- \`serverName\` should be a short kebab-case npm-style name ending in \`-mcp\`.`;

    const plan: ToolPlan = await this.anthropic.completeStructured({
      prompt,
      schema: ToolPlanSchema,
      schemaName: 'ToolPlan',
      maxTokens: 16000,
      caller: 'pipeline.planTools',
    });

    const tools = this.enforceScope(plan.tools, state, maxTools);

    if (tools.length === 0) {
      throw new Error('Tool planning produced no tools - cannot generate an MCP server');
    }

    state.generationPlan = {
      steps: plan.steps,
      toolsToGenerate: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: this.toJsonSchema(tool),
        readOnly: tool.readOnly,
      })),
      estimatedComplexity: plan.estimatedComplexity,
      serverName: plan.serverName,
      rationale: plan.rationale,
      scopeNotes: plan.scopeNotes,
    };

    const summary = `Planned ${tools.length} tools: ${tools.map((t) => t.name).join(', ')}`;
    this.push(state, 'planTools', summary);
    this.logger.log(summary, {
      conversationId: state.conversationId,
      rationale: plan.rationale,
      scopeNotes: plan.scopeNotes,
    });

    return summary;
  }

  /** Step: clarify - AI gap detection via ClarificationService. */
  private async clarify(state: PipelineState): Promise<string> {
    this.push(state, 'clarify', 'Analyzing for knowledge gaps...');

    try {
      const result = await this.clarificationService.orchestrateClarification(state);

      if (result.needsUserInput && result.questions?.length) {
        const questionsText = result.questions
          .map((q, i) => `${i + 1}. ${q.question}\n   Context: ${q.context}`)
          .join('\n\n');

        state.clarificationNeeded = {
          question: `I need some clarifications:\n\n${questionsText}`,
          context: 'pipeline_clarification',
          options: result.questions.flatMap((q) => q.options || []),
        };
        state.clarificationHistory = [
          ...(state.clarificationHistory || []),
          { gaps: result.gaps, questions: result.questions, timestamp: new Date() },
        ];
        state.needsUserInput = true;

        const summary = `Clarification needed: ${result.gaps.length} gaps detected`;
        this.push(state, 'clarify', summary);
        return summary;
      }

      this.push(state, 'clarify', 'No clarification needed, proceeding to refinement');
      return 'no gaps';
    } catch (error) {
      // Clarification is advisory - never let it block generation.
      await this.logError(error, 'clarify', state.conversationId);
      this.push(state, 'clarify', `Clarification skipped: ${error.message}`);
      return `skipped: ${error.message}`;
    }
  }

  /** Step: refine - Generate-Test-Refine until every tool works. */
  private async *refine(state: PipelineState): AsyncGenerator<PipelineUpdate> {
    for (let attempt = 1; attempt <= MAX_REFINEMENT_ITERATIONS; attempt++) {
      const iteration = (state.refinementIteration || 0) + 1;
      this.push(
        state,
        'refine',
        `Starting refinement iteration ${iteration}/${MAX_REFINEMENT_ITERATIONS}...`,
      );

      const result = await this.step(
        state,
        'refine',
        `iteration ${iteration}, ${state.generationPlan?.toolsToGenerate.length ?? 0} tools`,
        () => this.refinementService.refineUntilWorking(state),
        (refinement) =>
          `iteration ${refinement.iterations}: ` +
          `${refinement.testResults.toolsPassedCount}/${refinement.testResults.toolsFound} tools passing, ` +
          `success=${refinement.success}`,
      );

      state.generatedCode = result.generatedCode;
      state.refinementIteration = result.iterations;
      state.refinementHistory = [
        ...(state.refinementHistory || []),
        {
          iteration: result.iterations,
          testResults: result.testResults,
          failureAnalysis: result.failureAnalysis!,
          timestamp: new Date(),
        },
      ];

      this.push(
        state,
        'refine',
        `Iteration ${iteration}: ${result.testResults.toolsPassedCount}/${result.testResults.toolsFound} tools passing`,
      );

      if (result.success) {
        this.push(
          state,
          'refine',
          `✅ Success! All ${result.testResults.toolsPassedCount} tools working`,
        );
        state.response = `✅ Successfully generated and tested MCP server!

**All ${result.testResults.toolsPassedCount} tools validated**
- Build: ✓ Success
- MCP Protocol: ✓ Compliant
- Runtime: ✓ No errors

Iterations needed: ${result.iterations}/${MAX_REFINEMENT_ITERATIONS}`;

        // Countable unit: a *successful* generation (not a bare attempt, and
        // not partial success below) consumes one unit of the user's monthly
        // server quota. See UserService.checkCanGenerate for the rationale.
        await this.recordSuccessfulGeneration(state);

        yield this.snapshot(state);
        return;
      }

      if (!result.shouldContinue) {
        this.push(
          state,
          'refine',
          `⚠️ Max iterations reached: ${result.testResults.toolsPassedCount}/${result.testResults.toolsFound} tools working`,
        );
        state.response = `⚠️ Refinement completed with partial success:

**${result.testResults.toolsPassedCount}/${result.testResults.toolsFound} tools working**
- Build: ${result.testResults.buildSuccess ? '✓' : '✗'}
- Iterations: ${result.iterations}/${MAX_REFINEMENT_ITERATIONS}

${result.error || 'Some tools may need manual fixes.'}`;
        yield this.snapshot(state);
        return;
      }

      this.push(
        state,
        'refine',
        `Refining code based on ${result.failureAnalysis?.fixes.length || 0} fixes...`,
      );
      yield this.snapshot(state);
    }

    // Defensive: RefinementService stops asking to continue at its own cap, so
    // this is only reached if that contract changes. Never finish silently.
    if (!state.response) {
      state.response =
        `⚠️ Stopped after ${MAX_REFINEMENT_ITERATIONS} refinement iterations ` +
        'without a fully working server. The latest attempt has been saved.';
      this.push(state, 'refine', `⚠️ Refinement loop exhausted`);
      yield this.snapshot(state);
    }
  }

  /** Terminal step: persist generated artifacts and close the run. */
  private async *finish(state: PipelineState): AsyncGenerator<PipelineUpdate> {
    await this.step(
      state,
      'persist',
      state.generatedCode ? 'generated code' : 'response only',
      () => this.persist(state),
    );

    state.isComplete = true;
    state.needsUserInput = false;
    yield this.snapshot(state);
  }

  private async persist(state: PipelineState): Promise<string> {
    const conversationId = state.conversationId;
    if (!conversationId) {
      return 'no conversation';
    }

    if (state.response) {
      await this.saveMessageToConversation(conversationId, {
        role: 'assistant',
        content: state.response,
        timestamp: new Date(),
      });
    }

    // A completed run must not leave resumable state behind.
    await this.clearSavedState(conversationId);

    if (state.generatedCode) {
      await this.syncGeneratedCodeToConversation(conversationId, state);
      await this.writeGeneratedFilesToDisk(conversationId, state.generatedCode);
      const toolCount = state.generatedCode.metadata?.tools?.length ?? 0;
      return `persisted ${toolCount} tools to conversation + disk`;
    }

    return 'persisted response';
  }

  /**
   * Pause the run: persist the state so the user's next message resumes it
   * rather than starting over.
   */
  private async *pause(state: PipelineState): AsyncGenerator<PipelineUpdate> {
    state.needsUserInput = true;

    if (state.conversationId) {
      await this.step(state, 'persist', 'awaiting clarification', async () => {
        await this.saveMessageToConversation(state.conversationId!, {
          role: 'assistant',
          content: state.response || state.clarificationNeeded?.question || '',
          timestamp: new Date(),
        });
        await this.saveState(state.conversationId!, state);
        return 'saved resumable state';
      });
    }

    // isComplete closes the SSE turn; the pipeline resumes on the next message.
    state.isComplete = true;
    yield this.snapshot(state);
  }

  /** Terminal step: platform help text. */
  private provideHelp(state: PipelineState): string {
    state.response = `I'm the AI assistant for MCP Everything, a platform that generates Model Context Protocol (MCP) servers from any input.

**What is MCP?**
Model Context Protocol provides tools and resources that extend LLM capabilities by connecting them to external APIs, services, and data sources.

**What I can do:**
• Generate MCP servers from GitHub repositories
• Create MCP tools for any API (Stripe, GitHub, OpenAI, etc.)
• Build servers from API specifications (OpenAPI, GraphQL)
• Design MCP integrations from natural language descriptions

**Example requests:**
• "Create a Stripe MCP server for payment processing"
• "Generate MCP tools for the GitHub Issues API"
• "Build an MCP server from https://github.com/anthropics/anthropic-sdk-typescript"
• "I need an MCP server that can send emails via SendGrid"

**Default Stack:** I generate TypeScript + Node.js servers unless you specify otherwise.

What would you like to create?`;

    return 'help text';
  }

  /** Terminal step: user-facing error. */
  private handleError(state: PipelineState, error: Error, failedStep: PipelineStepName): string {
    state.error = error.message;
    state.response = `I encountered an error: ${error.message}. Please try again or rephrase your request.`;
    this.push(state, failedStep, `Error: ${error.message}`);
    return error.message;
  }

  // ---------------------------------------------------------------------------
  // Scope enforcement
  // ---------------------------------------------------------------------------

  private describeScope(state: PipelineState): string {
    const lines: string[] = [];

    if (state.requestedToolNames?.length) {
      lines.push(
        `- The user explicitly named these operations: ${state.requestedToolNames.join(', ')}. ` +
          'Generate exactly these, using these names.',
      );
    }
    if (state.requestedToolCount) {
      lines.push(`- The user asked for exactly ${state.requestedToolCount} tool(s).`);
    }
    if (state.readOnlyOnly) {
      lines.push(
        '- The user asked for READ-ONLY tools. Emit no create/update/delete/write tools of any kind.',
      );
    }
    if (state.scopeConstraint) {
      lines.push(`- Scope, in the user's terms: ${state.scopeConstraint}`);
    }
    if (lines.length === 0) {
      lines.push(
        '- The user set no explicit scope. Pick the smallest tool set that covers the request ' +
          `(3-7 tools), and never more than ${DEFAULT_MAX_TOOLS}.`,
      );
    }

    return lines.join('\n');
  }

  /**
   * Belt-and-braces enforcement of the scope the prompt already stated.
   *
   * The prompt is the primary mechanism; this is the deterministic backstop that
   * makes "exactly 3 read-only tools" a guarantee rather than a request.
   */
  private enforceScope(
    tools: ToolPlan['tools'],
    state: PipelineState,
    maxTools: number,
  ): ToolPlan['tools'] {
    let result = tools.filter((tool) => tool && tool.name && tool.description);

    if (state.readOnlyOnly) {
      const readOnly = result.filter((tool) => tool.readOnly);
      if (readOnly.length !== result.length) {
        this.logger.warn(
          `Dropping ${result.length - readOnly.length} mutating tool(s): user asked for read-only`,
        );
      }
      result = readOnly;
    }

    const requested = state.requestedToolNames;
    if (requested?.length) {
      const normalise = (name: string) => name.toLowerCase().replace(/[-\s]+/g, '_');
      const wanted = requested.map(normalise);
      const matched = result.filter((tool) => wanted.includes(normalise(tool.name)));

      // Only narrow to the requested names when the planner actually produced
      // them; otherwise keep its output rather than emitting nothing.
      if (matched.length > 0) {
        if (matched.length !== result.length) {
          this.logger.warn(
            `Dropping ${result.length - matched.length} unrequested tool(s): user named ${requested.join(', ')}`,
          );
        }
        result = matched;
      }
    }

    if (result.length > maxTools) {
      const priority = { high: 3, medium: 2, low: 1 } as const;
      this.logger.warn(`Capping tools from ${result.length} to ${maxTools} per user constraint`);
      result = [...result]
        .sort((a, b) => priority[b.priority] - priority[a.priority])
        .slice(0, maxTools);
    }

    return result;
  }

  /** Assemble a JSON Schema object from the planner's typed parameter list. */
  private toJsonSchema(tool: ToolPlan['tools'][number]): Record<string, unknown> {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const param of tool.parameters || []) {
      const property: Record<string, unknown> = {
        type: param.type,
        description: param.description,
      };

      if (param.enumValues?.length) {
        property.enum = param.enumValues;
      }
      if (param.type === 'array') {
        property.items = { type: param.itemsType || 'string' };
      }

      properties[param.name] = property;
      if (param.required) {
        required.push(param.name);
      }
    }

    return { type: 'object', properties, ...(required.length ? { required } : {}) };
  }

  // ---------------------------------------------------------------------------
  // Step instrumentation
  // ---------------------------------------------------------------------------

  /**
   * Run one pipeline step, recording a `pipeline_runs` row for it.
   *
   * A step returning a string uses it as the output summary; otherwise pass
   * `summarize` to describe the result.
   */
  private async step<T>(
    state: PipelineState,
    name: PipelineStepName,
    inputSummary: string,
    fn: () => Promise<T>,
    summarize?: (value: T) => string,
  ): Promise<T> {
    state.currentStep = name;
    if (!state.executedSteps.includes(name)) {
      state.executedSteps = [...state.executedSteps, name];
    }

    const startedAt = new Date();
    const run = await this.openRun(state.conversationId, name, startedAt, inputSummary);

    try {
      const value = await fn();
      const summary = summarize ? summarize(value) : typeof value === 'string' ? value : undefined;

      await this.closeRun(run, startedAt, 'succeeded', summary);
      return value;
    } catch (error) {
      await this.closeRun(run, startedAt, 'failed', undefined, error.message);
      throw error;
    }
  }

  private async openRun(
    conversationId: string | undefined,
    step: PipelineStepName,
    startedAt: Date,
    inputSummary: string,
  ): Promise<PipelineRun | null> {
    if (!conversationId) {
      return null;
    }

    try {
      return await this.pipelineRunRepo.save(
        this.pipelineRunRepo.create({
          conversationId,
          step,
          status: 'running',
          startedAt,
          inputSummary: this.truncate(inputSummary),
        }),
      );
    } catch (error) {
      // Observability must never take the pipeline down.
      this.logger.warn(`Failed to open pipeline_runs row for ${step}: ${error.message}`);
      return null;
    }
  }

  private async closeRun(
    run: PipelineRun | null,
    startedAt: Date,
    status: 'succeeded' | 'failed',
    outputSummary?: string,
    error?: string,
  ): Promise<void> {
    if (!run) {
      return;
    }

    const finishedAt = new Date();
    try {
      run.status = status;
      run.finishedAt = finishedAt;
      run.durationMs = finishedAt.getTime() - startedAt.getTime();
      run.outputSummary = this.truncate(outputSummary);
      run.error = this.truncate(error);
      await this.pipelineRunRepo.save(run);
    } catch (saveError) {
      this.logger.warn(`Failed to close pipeline_runs row: ${saveError.message}`);
    }
  }

  private truncate(text?: string): string | null {
    if (!text) {
      return null;
    }
    return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
  }

  // ---------------------------------------------------------------------------
  // Streaming
  // ---------------------------------------------------------------------------

  private push(state: PipelineState, node: PipelineStepName, message: string): void {
    const entry = { node, message, timestamp: new Date() };
    state.streamingUpdates = [...(state.streamingUpdates || []), entry];

    const queued = this.pending.get(state) || [];
    queued.push(entry);
    this.pending.set(state, queued);
  }

  /**
   * Build the update yielded to the SSE layer. `streamingUpdates` contains only
   * the entries produced since the previous yield, so no progress message is
   * ever dropped.
   */
  private snapshot(state: PipelineState): PipelineUpdate {
    const delta = this.pending.get(state) || [];
    this.pending.set(state, []);

    return { ...state, streamingUpdates: delta, conversationId: state.conversationId! };
  }

  // ---------------------------------------------------------------------------
  // Conversation persistence
  // ---------------------------------------------------------------------------

  /**
   * Load or create conversation from database.
   *
   * Ownership: when a userId is supplied, an existing conversation is only
   * returned if it belongs to that user. Conversations belonging to another
   * user (or legacy rows without an owner) are reported as not found so
   * existence is not leaked.
   */
  private async loadOrCreateConversation(
    sessionId: string,
    conversationId?: string,
    userId?: string,
  ): Promise<Conversation> {
    if (conversationId) {
      const existing = await this.conversationRepo.findOne({
        where: { id: conversationId, sessionId },
      });

      if (existing) {
        if (userId && existing.userId !== userId) {
          this.logger.warn(`Conversation ${conversationId} access denied for user ${userId}`);
          throw new NotFoundException(`Conversation not found: ${conversationId}`);
        }
        return existing;
      }
    }

    // Create new conversation - owned by the authenticated user when known
    const conversation = this.conversationRepo.create({
      sessionId,
      userId,
      messages: [],
      state: {},
      isActive: true,
    });

    return await this.conversationRepo.save(conversation);
  }

  /**
   * Read a resumable pipeline state off the conversation.
   *
   * Only states that were paused awaiting clarification are resumable; a
   * finished run starts fresh.
   */
  private readSavedState(conversation?: Conversation | null): PipelineState | null {
    const saved = conversation?.state?.pipeline;
    if (!saved || !saved.awaitingClarification || !saved.state) {
      return null;
    }
    return saved.state as PipelineState;
  }

  private async saveState(conversationId: string, state: PipelineState): Promise<void> {
    const conversation = await this.conversationRepo.findOne({ where: { id: conversationId } });
    if (!conversation) {
      return;
    }

    // Generated code is synced separately and is large - keep it out of the
    // resume payload.
    const resumable: Partial<PipelineState> = { ...state };
    delete resumable.generatedCode;
    delete resumable.streamingUpdates;

    conversation.state = {
      ...conversation.state,
      pipeline: {
        awaitingClarification: true,
        savedAt: new Date().toISOString(),
        state: resumable,
      },
    };
    conversation.updatedAt = new Date();
    await this.conversationRepo.save(conversation);

    this.logger.log(`Saved resumable pipeline state for conversation ${conversationId}`);
  }

  private async clearSavedState(conversationId: string): Promise<void> {
    const conversation = await this.conversationRepo.findOne({ where: { id: conversationId } });
    if (!conversation?.state?.pipeline) {
      return;
    }

    const remaining = { ...conversation.state };
    delete remaining.pipeline;
    conversation.state = remaining;
    conversation.updatedAt = new Date();
    await this.conversationRepo.save(conversation);
  }

  /**
   * Save a message to the conversation's messages array
   * FIX #130: Use save() instead of update() for reliable JSONB persistence
   */
  private async saveMessageToConversation(
    conversationId: string,
    message: { role: 'user' | 'assistant' | 'system'; content: string; timestamp: Date },
  ): Promise<void> {
    const conversation = await this.conversationRepo.findOne({
      where: { id: conversationId },
    });

    if (!conversation) {
      this.logger.error(`Conversation ${conversationId} not found for saving message`);
      return;
    }

    // Append message to existing messages array
    const messages = Array.isArray(conversation.messages) ? [...conversation.messages] : [];
    messages.push(message);

    conversation.messages = messages;
    conversation.updatedAt = new Date();

    // If this is the first user message, update the title
    if (message.role === 'user' && messages.filter((m) => m.role === 'user').length === 1) {
      const title = message.content.substring(0, 50) + (message.content.length > 50 ? '...' : '');
      conversation.state = {
        ...conversation.state,
        metadata: {
          ...(conversation.state?.metadata || {}),
          title,
        },
      };
      this.logger.log(`Set conversation title to: "${title}"`);
    }

    // Use save() for reliable JSONB column persistence
    await this.conversationRepo.save(conversation);

    this.logger.log(
      `Saved ${message.role} message to conversation ${conversationId} (total: ${messages.length})`,
    );
  }

  /**
   * FIX #128 + #130: Sync generated code and relevant state to conversation.state
   * This ensures deployment service can read the generated code from the conversation
   */
  private async syncGeneratedCodeToConversation(
    conversationId: string,
    state: PipelineState,
  ): Promise<void> {
    const conversation = await this.conversationRepo.findOne({
      where: { id: conversationId },
    });

    if (!conversation) {
      this.logger.error(`Conversation ${conversationId} not found for state sync`);
      return;
    }

    const tools = state.generatedCode?.metadata?.tools || [];

    conversation.state = {
      ...conversation.state,
      generatedCode: state.generatedCode,
      serverName: state.generatedCode?.metadata?.serverName,
      tools: tools.map((t: any) => ({
        name: t.name,
        description: t.description || `Tool: ${t.name}`,
      })),
      metadata: {
        ...(conversation.state?.metadata || {}),
        generatedAt: new Date().toISOString(),
        toolCount: tools.length,
      },
    };
    conversation.updatedAt = new Date();

    await this.conversationRepo.save(conversation);

    this.logger.log(
      `Synced generated code to conversation ${conversationId} (${tools.length} tools)`,
    );
  }

  /**
   * FIX #128: Write generated files to disk for deployment
   * This ensures deployment service can read files from the filesystem
   */
  private async writeGeneratedFilesToDisk(
    conversationId: string,
    generatedCode: PipelineState['generatedCode'],
  ): Promise<void> {
    if (!generatedCode) {
      this.logger.warn(`No generated code to write for conversation ${conversationId}`);
      return;
    }

    const serverDir = join(this.generatedServersDir, conversationId);

    try {
      if (!existsSync(serverDir)) {
        mkdirSync(serverDir, { recursive: true });
      }

      if (generatedCode.mainFile) {
        const mainPath = join(serverDir, 'src', 'index.ts');
        const mainDir = dirname(mainPath);
        if (!existsSync(mainDir)) {
          mkdirSync(mainDir, { recursive: true });
        }
        writeFileSync(mainPath, generatedCode.mainFile);
        this.logger.log(`Wrote main file: ${mainPath}`);
      }

      if (generatedCode.packageJson) {
        const pkgPath = join(serverDir, 'package.json');
        writeFileSync(pkgPath, generatedCode.packageJson);
        this.logger.log(`Wrote package.json: ${pkgPath}`);
      }

      if (generatedCode.tsConfig) {
        const tsconfigPath = join(serverDir, 'tsconfig.json');
        writeFileSync(tsconfigPath, generatedCode.tsConfig);
        this.logger.log(`Wrote tsconfig.json: ${tsconfigPath}`);
      }

      if (generatedCode.supportingFiles) {
        for (const [path, content] of Object.entries(generatedCode.supportingFiles)) {
          const filePath = join(serverDir, path);
          const fileDir = dirname(filePath);
          if (!existsSync(fileDir)) {
            mkdirSync(fileDir, { recursive: true });
          }
          writeFileSync(filePath, content);
          this.logger.log(`Wrote supporting file: ${filePath}`);
        }
      }

      writeFileSync(join(serverDir, 'README.md'), this.generateReadme(generatedCode));

      this.logger.log(`Successfully wrote generated files to ${serverDir}`);
    } catch (error) {
      this.logger.error(`Failed to write generated files for ${conversationId}: ${error.message}`);
      throw error;
    }
  }

  /** Generate a README for the MCP server. */
  private generateReadme(generatedCode: PipelineState['generatedCode']): string {
    const serverName = generatedCode?.metadata?.serverName || 'MCP Server';
    const tools = generatedCode?.metadata?.tools || [];

    const toolsList = tools
      .map((t: any) => `- **${t.name}**: ${t.description || 'No description'}`)
      .join('\n');

    return `# ${serverName}

Generated MCP Server with ${tools.length} tool(s).

## Tools

${toolsList || '- No tools defined'}

## Installation

\`\`\`bash
npm install
npm run build
\`\`\`

## Usage

\`\`\`bash
npm start
\`\`\`

## Generated by MCP Everything

This server was automatically generated by the MCP Everything platform.
`;
  }

  // ---------------------------------------------------------------------------
  // Error logging
  // ---------------------------------------------------------------------------

  /** Log an error to the database (if ErrorLoggingService is available). */
  private async logError(
    error: Error,
    method: string,
    conversationId?: string,
    context?: Record<string, any>,
  ): Promise<void> {
    if (!this.errorLoggingService) {
      return;
    }

    try {
      await this.errorLoggingService.logError({
        error,
        service: 'GenerationPipeline',
        method,
        conversationId,
        context,
      });
    } catch (logError) {
      // Don't let logging failures break the main flow
      this.logger.error(`Failed to log error to database: ${logError.message}`);
    }
  }
}
