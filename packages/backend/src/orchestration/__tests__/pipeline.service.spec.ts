/// <reference types="jest" />
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { GenerationPipeline, PipelineUpdate } from '../pipeline.service';
import { ResearchService } from '../research.service';
import { ClarificationService } from '../clarification.service';
import { RefinementService } from '../refinement.service';
import { UserService } from '../../user/user.service';
import { AnthropicService } from '../../ai/anthropic.service';
import { StructuredLoggerService } from '../../logging/structured-logger.service';
import { Conversation, PipelineRun } from '../../database/entities';
import { createMockAnthropicService } from './__mocks__/anthropic.mock';
import { createMockLogger, createMockTestResults } from './__mocks__/test-utils';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION_ID = 'sess-1';
const CONVERSATION_ID = 'conv-1';
const USER_ID = 'user-1';

const intentResponse = (overrides: Record<string, any> = {}) =>
  JSON.stringify({
    intent: 'generate_mcp',
    confidence: 0.95,
    githubUrl: null,
    // A concrete target the user named. The intent gate refuses to start
    // researching without one, so every "proceeds normally" fixture needs it.
    targetService: 'JSONPlaceholder',
    missingInfo: null,
    reasoning: 'User wants an MCP server',
    scope: {
      requestedToolCount: null,
      requestedToolNames: null,
      readOnlyOnly: null,
      scopeConstraint: null,
      ...(overrides.scope || {}),
    },
    ...(() => {
      const { scope: _scope, ...rest } = overrides;
      return rest;
    })(),
  });

const planTool = (name: string, readOnly = true) => ({
  name,
  description: `Tool ${name}`,
  readOnly,
  priority: 'high',
  estimatedComplexity: 'simple',
  parameters: [
    { name: 'id', type: 'string', description: 'Identifier', required: true },
    {
      name: 'status',
      type: 'string',
      description: 'Status filter',
      required: false,
      enumValues: ['open', 'closed'],
    },
  ],
});

const planResponse = (tools: any[]) =>
  JSON.stringify({
    serverName: 'jsonplaceholder-mcp',
    tools,
    steps: ['Set up project', 'Implement tools'],
    estimatedComplexity: 'simple',
    rationale: 'Exactly the operations the user asked for',
    scopeNotes: 'Honoured the stated scope',
  });

const researchPhase = (confidence = 0.9) => ({
  webSearchFindings: {
    queries: ['jsonplaceholder api'],
    results: [{ url: 'https://jsonplaceholder.typicode.com', title: 'Docs', snippet: 'REST API' }],
    patterns: ['REST'],
    bestPractices: ['Base URL: https://jsonplaceholder.typicode.com'],
    timestamp: new Date(),
  },
  synthesizedPlan: {
    summary: 'JSONPlaceholder REST API',
    keyInsights: ['No auth required'],
    recommendedApproach: 'axios + MCP SDK',
    potentialChallenges: [],
    confidence,
    reasoning: 'Well documented',
  },
  researchConfidence: confidence,
  researchIterations: 1,
});

const generatedCode = () => ({
  mainFile: 'import { Server } from "@modelcontextprotocol/sdk/server/index.js";\n',
  packageJson: '{"name":"jsonplaceholder-mcp"}',
  tsConfig: '{"compilerOptions":{}}',
  supportingFiles: { Dockerfile: 'FROM node:20-alpine\n' },
  metadata: {
    tools: [{ name: 'list_posts', description: 'List posts' }],
    iteration: 1,
    serverName: 'jsonplaceholder-mcp',
  },
});

// ---------------------------------------------------------------------------
// Repository fakes (stateful - the pipeline reads back what it writes)
// ---------------------------------------------------------------------------

function createConversationRepoFake(initial: Record<string, any> = {}) {
  const row: Record<string, any> = {
    id: CONVERSATION_ID,
    sessionId: SESSION_ID,
    userId: USER_ID,
    messages: [],
    state: {},
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...initial,
  };

  return {
    row,
    create: jest.fn((data: any) => ({ ...row, ...data })),
    save: jest.fn(async (entity: any) => {
      Object.assign(row, entity, { id: row.id });
      return row;
    }),
    findOne: jest.fn(async ({ where }: any) => {
      if (where.id && where.id !== row.id) return null;
      if (where.sessionId && where.sessionId !== row.sessionId) return null;
      if (where.userId && where.userId !== row.userId) return null;
      return row;
    }),
  };
}

function createPipelineRunRepoFake() {
  const rows: any[] = [];
  return {
    rows,
    create: jest.fn((data: any) => ({ ...data })),
    save: jest.fn(async (entity: any) => {
      if (!rows.includes(entity)) {
        rows.push(entity);
      }
      return entity;
    }),
  };
}

async function collect(
  generator: AsyncGenerator<PipelineUpdate>,
): Promise<PipelineUpdate[]> {
  const updates: PipelineUpdate[] = [];
  for await (const update of generator) {
    updates.push(update);
  }
  return updates;
}

/** All progress messages, in the order the SSE layer would emit them. */
const progressMessages = (updates: PipelineUpdate[]): string[] =>
  updates.flatMap((u) => (u.streamingUpdates || []).map((e) => e.message));

// ---------------------------------------------------------------------------

describe('GenerationPipeline', () => {
  let service: GenerationPipeline;
  let conversationRepo: ReturnType<typeof createConversationRepoFake>;
  let pipelineRunRepo: ReturnType<typeof createPipelineRunRepoFake>;
  let researchService: any;
  let clarificationService: any;
  let refinementService: any;
  let userService: any;
  let errorLoggingService: any;
  let mockLlmInvoke: jest.Mock;
  let generatedDir: string;
  /** Extra ConfigService values a test wants; set, then rebuild via build(). */
  let configValues: Record<string, any>;

  /** Route structured calls by prompt so ordering never matters. */
  const respondWith = (options: { intent?: string; plan?: string }) => {
    mockLlmInvoke.mockImplementation(async (prompt: string) => {
      if (prompt.includes('Determine primary intent')) {
        return { content: options.intent ?? intentResponse() };
      }
      if (prompt.includes('Decide exactly which MCP tools')) {
        return { content: options.plan ?? planResponse([planTool('list_posts')]) };
      }
      throw new Error(`Unexpected prompt: ${prompt.slice(0, 120)}`);
    });
  };

  const build = async (): Promise<GenerationPipeline> => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GenerationPipeline,
        { provide: getRepositoryToken(Conversation), useValue: conversationRepo },
        { provide: getRepositoryToken(PipelineRun), useValue: pipelineRunRepo },
        { provide: ResearchService, useValue: researchService },
        { provide: ClarificationService, useValue: clarificationService },
        { provide: RefinementService, useValue: refinementService },
        { provide: UserService, useValue: userService },
        { provide: AnthropicService, useValue: createMockAnthropicService(mockLlmInvoke) },
        { provide: StructuredLoggerService, useValue: createMockLogger() },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string, fallback?: any) => {
              if (key === 'GENERATED_SERVERS_DIR') return generatedDir;
              return key in configValues ? configValues[key] : fallback;
            },
          },
        },
        { provide: 'ErrorLoggingService', useValue: errorLoggingService },
      ],
    })
      // ErrorLoggingService is @Optional() and injected by class token
      .overrideProvider(StructuredLoggerService)
      .useValue(createMockLogger())
      .compile();

    return module.get<GenerationPipeline>(GenerationPipeline);
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    generatedDir = mkdtempSync(join(tmpdir(), 'pipeline-spec-'));
    configValues = {};

    mockLlmInvoke = jest.fn();
    conversationRepo = createConversationRepoFake();
    pipelineRunRepo = createPipelineRunRepoFake();

    researchService = {
      conductResearch: jest.fn().mockResolvedValue(researchPhase()),
    };
    clarificationService = {
      orchestrateClarification: jest
        .fn()
        .mockResolvedValue({ complete: true, gaps: [], needsUserInput: false }),
    };
    refinementService = {
      refineUntilWorking: jest.fn().mockResolvedValue({
        success: true,
        generatedCode: generatedCode(),
        testResults: createMockTestResults(true, 1),
        iterations: 1,
        shouldContinue: false,
      }),
    };
    errorLoggingService = { logError: jest.fn() };

    userService = {
      checkCanGenerate: jest.fn().mockResolvedValue({ allowed: true }),
      incrementUsage: jest.fn().mockResolvedValue({}),
    };

    respondWith({});
    service = await build();
  });

  afterEach(() => {
    rmSync(generatedDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------

  describe('happy path', () => {
    it('runs every step in order and completes', async () => {
      const updates = await collect(
        await service.execute(SESSION_ID, 'MCP server for JSONPlaceholder', CONVERSATION_ID, USER_ID),
      );

      const final = updates[updates.length - 1];
      expect(final.isComplete).toBe(true);
      expect(final.needsUserInput).toBe(false);
      expect(final.error).toBeUndefined();
      expect(final.executedSteps).toEqual([
        'analyzeIntent',
        'research',
        'planTools',
        'clarify',
        'refine',
        'persist',
      ]);

      expect(researchService.conductResearch).toHaveBeenCalledTimes(1);
      expect(clarificationService.orchestrateClarification).toHaveBeenCalledTimes(1);
      expect(refinementService.refineUntilWorking).toHaveBeenCalledTimes(1);
    });

    it('turns the planner output into a generation plan with JSON Schema parameters', async () => {
      await collect(
        await service.execute(SESSION_ID, 'MCP server for JSONPlaceholder', CONVERSATION_ID, USER_ID),
      );

      const state = refinementService.refineUntilWorking.mock.calls[0][0];
      expect(state.generationPlan.serverName).toBe('jsonplaceholder-mcp');
      expect(state.generationPlan.rationale).toContain('Exactly the operations');
      expect(state.generationPlan.toolsToGenerate).toHaveLength(1);
      expect(state.generationPlan.toolsToGenerate[0]).toMatchObject({
        name: 'list_posts',
        readOnly: true,
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Identifier' },
            status: { type: 'string', description: 'Status filter', enum: ['open', 'closed'] },
          },
          required: ['id'],
        },
      });
    });

    it('persists messages, syncs generated code and writes files to disk', async () => {
      await collect(
        await service.execute(SESSION_ID, 'MCP server for JSONPlaceholder', CONVERSATION_ID, USER_ID),
      );

      // user message + assistant response
      expect(conversationRepo.row.messages.map((m: any) => m.role)).toEqual([
        'user',
        'assistant',
      ]);
      expect(conversationRepo.row.state.serverName).toBe('jsonplaceholder-mcp');
      expect(conversationRepo.row.state.tools).toEqual([
        { name: 'list_posts', description: 'List posts' },
      ]);
      // A completed run leaves no resumable state behind
      expect(conversationRepo.row.state.pipeline).toBeUndefined();

      const dir = join(generatedDir, CONVERSATION_ID);
      expect(existsSync(join(dir, 'src', 'index.ts'))).toBe(true);
      expect(existsSync(join(dir, 'package.json'))).toBe(true);
      expect(existsSync(join(dir, 'tsconfig.json'))).toBe(true);
      expect(existsSync(join(dir, 'Dockerfile'))).toBe(true);
      expect(readFileSync(join(dir, 'README.md'), 'utf-8')).toContain('list_posts');
    });

    it('answers a help request without researching or generating', async () => {
      respondWith({ intent: intentResponse({ intent: 'help' }) });

      const updates = await collect(
        await service.execute(SESSION_ID, 'what can you do?', CONVERSATION_ID, USER_ID),
      );

      const final = updates[updates.length - 1];
      expect(final.isComplete).toBe(true);
      expect(final.response).toContain('MCP Everything');
      expect(final.executedSteps).toEqual(['analyzeIntent', 'provideHelp', 'persist']);
      expect(researchService.conductResearch).not.toHaveBeenCalled();
      expect(refinementService.refineUntilWorking).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------

  describe('scope constraints', () => {
    const scopedIntent = () =>
      intentResponse({
        scope: {
          requestedToolCount: 3,
          requestedToolNames: ['list_posts', 'get_post', 'list_comments'],
          readOnlyOnly: true,
          scopeConstraint: 'only those three read operations',
        },
      });

    it('passes the user constraints into the planTools prompt', async () => {
      respondWith({
        intent: scopedIntent(),
        plan: planResponse([
          planTool('list_posts'),
          planTool('get_post'),
          planTool('list_comments'),
        ]),
      });

      await collect(
        await service.execute(
          SESSION_ID,
          'MCP server for JSONPlaceholder: list posts, get post, list comments',
          CONVERSATION_ID,
          USER_ID,
        ),
      );

      const planPrompt = mockLlmInvoke.mock.calls
        .map((call) => call[0] as string)
        .find((prompt) => prompt.includes('Decide exactly which MCP tools'))!;

      expect(planPrompt).toContain('list_posts, get_post, list_comments');
      expect(planPrompt).toContain('exactly 3 tool(s)');
      expect(planPrompt).toContain('READ-ONLY');
      expect(planPrompt).toContain('only those three read operations');
      // Research findings must reach the planner too
      expect(planPrompt).toContain('JSONPlaceholder REST API');
      expect(planPrompt).toContain('Base URL: https://jsonplaceholder.typicode.com');
    });

    it('yields exactly the requested read-only tools even when the model over-reaches', async () => {
      respondWith({
        intent: scopedIntent(),
        plan: planResponse([
          planTool('list_posts'),
          planTool('get_post'),
          planTool('list_comments'),
          planTool('create_post', false),
          planTool('delete_post', false),
          planTool('update_post', false),
          planTool('search_posts'),
        ]),
      });

      await collect(
        await service.execute(
          SESSION_ID,
          'MCP server for JSONPlaceholder: list posts, get post, list comments',
          CONVERSATION_ID,
          USER_ID,
        ),
      );

      const state = refinementService.refineUntilWorking.mock.calls[0][0];
      expect(state.generationPlan.toolsToGenerate.map((t: any) => t.name)).toEqual([
        'list_posts',
        'get_post',
        'list_comments',
      ]);
      expect(state.requestedToolCount).toBe(3);
      expect(state.readOnlyOnly).toBe(true);
    });

    it('caps an unconstrained plan at the default ceiling', async () => {
      const many = Array.from({ length: 14 }, (_, i) => planTool(`tool_${i}`));
      respondWith({ plan: planResponse(many) });

      await collect(
        await service.execute(SESSION_ID, 'MCP server for something', CONVERSATION_ID, USER_ID),
      );

      const state = refinementService.refineUntilWorking.mock.calls[0][0];
      expect(state.generationPlan.toolsToGenerate).toHaveLength(10);
    });

    it('fails the run when planning yields no usable tools', async () => {
      respondWith({ plan: planResponse([]) });

      const updates = await collect(
        await service.execute(SESSION_ID, 'MCP server for something', CONVERSATION_ID, USER_ID),
      );

      const final = updates[updates.length - 1];
      expect(final.isComplete).toBe(true);
      expect(final.error).toMatch(/no tools/i);
      expect(refinementService.refineUntilWorking).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------

  describe('clarification pause and resume', () => {
    const pauseOnce = () => {
      clarificationService.orchestrateClarification
        .mockResolvedValueOnce({
          complete: false,
          needsUserInput: true,
          gaps: [
            {
              issue: 'Base URL unknown',
              priority: 'HIGH',
              suggestedQuestion: 'What is the base URL?',
              context: 'Needed to build requests',
            },
          ],
          questions: [
            {
              question: 'What is the base URL?',
              context: 'Needed to build requests',
              required: true,
              options: ['https://api.example.com'],
            },
          ],
        })
        .mockResolvedValue({ complete: true, gaps: [], needsUserInput: false });
    };

    it('pauses with a question and saves resumable state', async () => {
      pauseOnce();

      const updates = await collect(
        await service.execute(SESSION_ID, 'MCP server for MyCustomAPI', CONVERSATION_ID, USER_ID),
      );

      const final = updates[updates.length - 1];
      expect(final.needsUserInput).toBe(true);
      expect(final.isComplete).toBe(true); // closes the SSE turn
      expect(final.clarificationNeeded?.question).toContain('What is the base URL?');
      expect(final.clarificationNeeded?.options).toEqual(['https://api.example.com']);
      expect(refinementService.refineUntilWorking).not.toHaveBeenCalled();

      const saved = conversationRepo.row.state.pipeline;
      expect(saved.awaitingClarification).toBe(true);
      expect(saved.state.researchPhase).toBeDefined();
      expect(saved.state.generationPlan).toBeDefined();
      // Large payloads stay out of the resume record
      expect(saved.state.generatedCode).toBeUndefined();
    });

    it('resumes on the next message without re-running research', async () => {
      pauseOnce();

      await collect(
        await service.execute(SESSION_ID, 'MCP server for MyCustomAPI', CONVERSATION_ID, USER_ID),
      );
      expect(researchService.conductResearch).toHaveBeenCalledTimes(1);

      const updates = await collect(
        await service.execute(
          SESSION_ID,
          'The base URL is https://api.example.com',
          CONVERSATION_ID,
          USER_ID,
        ),
      );

      const final = updates[updates.length - 1];
      expect(final.isComplete).toBe(true);
      expect(final.needsUserInput).toBe(false);
      expect(final.response).toContain('Successfully generated');

      // Research is resumed from saved state, never repeated
      expect(researchService.conductResearch).toHaveBeenCalledTimes(1);
      // The resumed run skips intent analysis and goes straight to planning
      expect(final.executedSteps).toEqual(['planTools', 'clarify', 'refine', 'persist']);
      expect(refinementService.refineUntilWorking).toHaveBeenCalledTimes(1);

      // Resumable state is cleared once the run finishes
      expect(conversationRepo.row.state.pipeline).toBeUndefined();
    });

    it('feeds the user answer back into the planner on resume', async () => {
      pauseOnce();

      await collect(
        await service.execute(SESSION_ID, 'MCP server for MyCustomAPI', CONVERSATION_ID, USER_ID),
      );
      mockLlmInvoke.mockClear();

      await collect(
        await service.execute(
          SESSION_ID,
          'The base URL is https://api.example.com',
          CONVERSATION_ID,
          USER_ID,
        ),
      );

      const planPrompt = mockLlmInvoke.mock.calls
        .map((call) => call[0] as string)
        .find((prompt) => prompt.includes('Decide exactly which MCP tools'))!;

      expect(planPrompt).toContain('Clarifications the user already answered');
      expect(planPrompt).toContain('https://api.example.com');
    });

    it('pauses when research confidence is too low to plan against', async () => {
      researchService.conductResearch.mockResolvedValue(researchPhase(0.2));

      const updates = await collect(
        await service.execute(SESSION_ID, 'MCP server for ???', CONVERSATION_ID, USER_ID),
      );

      const final = updates[updates.length - 1];
      expect(final.needsUserInput).toBe(true);
      expect(final.clarificationNeeded?.context).toBe('low_research_confidence');
      expect(final.executedSteps).toEqual(['analyzeIntent', 'research', 'persist']);
    });

    /**
     * A pause from the intent gate happens *before* research. Resuming such a
     * run used to jump straight to planTools, planning tools from zero
     * researched facts ("research confidence 0.00") - it only ever appeared to
     * work when the model happened to know the API from priors.
     */
    it('resumes AT research when the pause happened before research ran', async () => {
      respondWith({ intent: intentResponse({ targetService: null }) });

      await collect(
        await service.execute(SESSION_ID, 'make me an MCP server', CONVERSATION_ID, USER_ID),
      );
      expect(researchService.conductResearch).not.toHaveBeenCalled();
      expect(conversationRepo.row.state.pipeline.state.researchPhase).toBeUndefined();

      respondWith({});
      const updates = await collect(
        await service.execute(SESSION_ID, 'the JSONPlaceholder API', CONVERSATION_ID, USER_ID),
      );

      const final = updates[updates.length - 1];
      expect(final.isComplete).toBe(true);
      expect(final.needsUserInput).toBe(false);
      // Research runs on the resumed turn, before planning
      expect(researchService.conductResearch).toHaveBeenCalledTimes(1);
      expect(final.executedSteps).toEqual([
        'research',
        'planTools',
        'clarify',
        'refine',
        'persist',
      ]);
      // ...and the planner sees real research, not confidence 0.00
      const planRow = pipelineRunRepo.rows.find((r) => r.step === 'planTools');
      expect(planRow.inputSummary).toBe('research confidence 0.90');
    });

    it('re-runs research on resume when saved research has zero confidence', async () => {
      pauseOnce();
      researchService.conductResearch.mockResolvedValue({
        ...researchPhase(0.9),
        researchConfidence: 0,
      });

      await collect(
        await service.execute(SESSION_ID, 'MCP server for MyCustomAPI', CONVERSATION_ID, USER_ID),
      );

      // A zero-confidence result is not research worth planning against
      researchService.conductResearch.mockResolvedValue(researchPhase(0.9));
      const updates = await collect(
        await service.execute(SESSION_ID, 'it is JSONPlaceholder', CONVERSATION_ID, USER_ID),
      );

      expect(researchService.conductResearch).toHaveBeenCalledTimes(2);
      expect(updates[updates.length - 1].executedSteps).toContain('research');
    });

    it('still skips research on resume when the paused run actually researched', async () => {
      pauseOnce();

      await collect(
        await service.execute(SESSION_ID, 'MCP server for MyCustomAPI', CONVERSATION_ID, USER_ID),
      );
      expect(researchService.conductResearch).toHaveBeenCalledTimes(1);

      const updates = await collect(
        await service.execute(SESSION_ID, 'https://api.example.com', CONVERSATION_ID, USER_ID),
      );

      expect(researchService.conductResearch).toHaveBeenCalledTimes(1);
      expect(updates[updates.length - 1].executedSteps).not.toContain('research');
    });

    it('pauses when intent analysis reports a critical blocker', async () => {
      respondWith({
        intent: intentResponse({ intent: 'unknown', missingInfo: ['which service'] }),
      });

      const updates = await collect(
        await service.execute(SESSION_ID, 'make me a thing', CONVERSATION_ID, USER_ID),
      );

      const final = updates[updates.length - 1];
      expect(final.needsUserInput).toBe(true);
      expect(final.response).toContain('which service');
      expect(researchService.conductResearch).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------

  /**
   * The gate that decides whether a request is concrete enough to spend money
   * on. Regression cover for the run where "make me an MCP server for my stuff"
   * was classified `clarify` at confidence 0.65, sailed through, and research
   * invented AWS S3 with 0.85 confidence - five refinement iterations on tools
   * for a service the user never mentioned.
   */
  describe('intent gate', () => {
    /** Nothing expensive may have started. */
    const expectNoExpensiveWork = () => {
      expect(researchService.conductResearch).not.toHaveBeenCalled();
      expect(clarificationService.orchestrateClarification).not.toHaveBeenCalled();
      expect(refinementService.refineUntilWorking).not.toHaveBeenCalled();
      expect(pipelineRunRepo.rows.map((r) => r.step)).toEqual(['analyzeIntent', 'persist']);
    };

    it('pauses when the request names no identifiable target', async () => {
      respondWith({
        intent: intentResponse({
          intent: 'generate_mcp',
          confidence: 0.9,
          targetService: null,
        }),
      });

      const updates = await collect(
        await service.execute(
          SESSION_ID,
          'make me an MCP server for my stuff',
          CONVERSATION_ID,
          USER_ID,
        ),
      );

      const final = updates[updates.length - 1];
      expect(final.needsUserInput).toBe(true);
      expect(final.clarificationNeeded?.context).toBe('no_identifiable_target');
      expect(final.response).toContain('Which service, API or repository');
      expectNoExpensiveWork();
    });

    it('pauses when intent confidence is below the threshold, even with a target', async () => {
      respondWith({
        intent: intentResponse({ confidence: 0.65, targetService: 'something file-ish' }),
      });

      const updates = await collect(
        await service.execute(SESSION_ID, 'a server for my stuff', CONVERSATION_ID, USER_ID),
      );

      const final = updates[updates.length - 1];
      expect(final.needsUserInput).toBe(true);
      expect(final.clarificationNeeded?.context).toBe('low_intent_confidence');
      expectNoExpensiveWork();
    });

    it("pauses on a 'clarify' intent when no question is outstanding", async () => {
      respondWith({ intent: intentResponse({ intent: 'clarify', confidence: 0.95 }) });

      const updates = await collect(
        await service.execute(SESSION_ID, 'yes, that one', CONVERSATION_ID, USER_ID),
      );

      const final = updates[updates.length - 1];
      expect(final.needsUserInput).toBe(true);
      expect(final.clarificationNeeded?.context).toBe('unmatched_clarification');
      expectNoExpensiveWork();
    });

    it('proceeds when the request is confident and names a target', async () => {
      respondWith({
        intent: intentResponse({ confidence: 0.76, targetService: 'JSONPlaceholder' }),
      });

      const updates = await collect(
        await service.execute(
          SESSION_ID,
          'MCP server for JSONPlaceholder',
          CONVERSATION_ID,
          USER_ID,
        ),
      );

      const final = updates[updates.length - 1];
      expect(final.needsUserInput).toBe(false);
      expect(final.clarificationNeeded).toBeUndefined();
      expect(researchService.conductResearch).toHaveBeenCalledTimes(1);
      expect(refinementService.refineUntilWorking).toHaveBeenCalledTimes(1);
    });

    it('accepts a repository URL as the target when no service was named', async () => {
      respondWith({
        intent: intentResponse({
          targetService: null,
          githubUrl: 'https://github.com/typicode/jsonplaceholder',
        }),
      });

      const updates = await collect(
        await service.execute(
          SESSION_ID,
          'build one from https://github.com/typicode/jsonplaceholder',
          CONVERSATION_ID,
          USER_ID,
        ),
      );

      expect(updates[updates.length - 1].needsUserInput).toBe(false);
      expect(researchService.conductResearch).toHaveBeenCalledTimes(1);
    });

    it('honours PIPELINE_INTENT_CONFIDENCE_MIN from config', async () => {
      configValues.PIPELINE_INTENT_CONFIDENCE_MIN = '0.5';
      service = await build();
      respondWith({ intent: intentResponse({ confidence: 0.65 }) });

      const updates = await collect(
        await service.execute(SESSION_ID, 'MCP server for JSONPlaceholder', CONVERSATION_ID, USER_ID),
      );

      // 0.65 clears a 0.5 floor, so the run proceeds where it would not by default
      expect(updates[updates.length - 1].needsUserInput).toBe(false);
      expect(researchService.conductResearch).toHaveBeenCalledTimes(1);
    });

    it('falls back to the default threshold when the configured one is nonsense', async () => {
      configValues.PIPELINE_INTENT_CONFIDENCE_MIN = 'banana';
      service = await build();
      respondWith({ intent: intentResponse({ confidence: 0.65 }) });

      const updates = await collect(
        await service.execute(SESSION_ID, 'MCP server for JSONPlaceholder', CONVERSATION_ID, USER_ID),
      );

      expect(updates[updates.length - 1].clarificationNeeded?.context).toBe(
        'low_intent_confidence',
      );
      expect(researchService.conductResearch).not.toHaveBeenCalled();
    });

    it('saves resumable state so the answer continues the same run', async () => {
      respondWith({ intent: intentResponse({ targetService: null }) });

      await collect(
        await service.execute(SESSION_ID, 'make me an MCP server', CONVERSATION_ID, USER_ID),
      );

      const saved = conversationRepo.row.state.pipeline;
      expect(saved.awaitingClarification).toBe(true);
      // Nothing researched yet - that is the whole point of pausing here
      expect(saved.state.researchPhase).toBeUndefined();
      expect(saved.state.generationPlan).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------

  describe('streaming updates', () => {
    it('emits every progress entry exactly once, including multiple per step', async () => {
      const updates = await collect(
        await service.execute(SESSION_ID, 'MCP server for JSONPlaceholder', CONVERSATION_ID, USER_ID),
      );

      const messages = progressMessages(updates);

      // Steps that emit two entries (start + result) must not lose the first.
      expect(messages).toEqual([
        expect.stringContaining('Analyzed intent: generate_mcp'),
        'Starting comprehensive research phase...',
        'Research complete: confidence 0.90',
        'Planning MCP tool surface...',
        'Planned 1 tools: list_posts',
        'Analyzing for knowledge gaps...',
        'No clarification needed, proceeding to refinement',
        'Starting refinement iteration 1/5...',
        'Iteration 1: 1/1 tools passing',
        '✅ Success! All 1 tools working',
      ]);

      // No duplicates across yields
      expect(new Set(messages).size).toBe(messages.length);
    });

    it('reports the scope constraint in the intent progress message', async () => {
      respondWith({
        intent: intentResponse({
          scope: {
            requestedToolCount: 2,
            requestedToolNames: ['list_posts', 'get_post'],
            readOnlyOnly: true,
          },
        }),
        plan: planResponse([planTool('list_posts'), planTool('get_post')]),
      });

      const updates = await collect(
        await service.execute(SESSION_ID, 'list posts and get post', CONVERSATION_ID, USER_ID),
      );

      expect(progressMessages(updates)[0]).toBe(
        'Analyzed intent: generate_mcp (confidence: 0.95) | Tool constraint: 2 tools (list_posts, get_post) | read-only',
      );
    });

    it('streams progress before the run finishes rather than all at the end', async () => {
      const generator = await service.execute(
        SESSION_ID,
        'MCP server for JSONPlaceholder',
        CONVERSATION_ID,
        USER_ID,
      );

      const first = await generator.next();
      expect(first.done).toBe(false);
      expect(first.value.isComplete).toBeFalsy();
      expect(first.value.streamingUpdates?.[0].node).toBe('analyzeIntent');
      expect(refinementService.refineUntilWorking).not.toHaveBeenCalled();

      await collect(generator);
      expect(refinementService.refineUntilWorking).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------

  describe('error handling', () => {
    it('surfaces a failing step as an error response and still completes the turn', async () => {
      researchService.conductResearch.mockRejectedValue(new Error('GitHub API exploded'));

      const updates = await collect(
        await service.execute(SESSION_ID, 'MCP server for JSONPlaceholder', CONVERSATION_ID, USER_ID),
      );

      const final = updates[updates.length - 1];
      expect(final.isComplete).toBe(true);
      expect(final.error).toBe('GitHub API exploded');
      expect(final.response).toContain('I encountered an error: GitHub API exploded');
      expect(progressMessages(updates)).toContain('Error: GitHub API exploded');
      expect(final.executedSteps).toContain('handleError');
    });

    it('records a failed pipeline_runs row for the step that threw', async () => {
      refinementService.refineUntilWorking.mockRejectedValue(new Error('docker unavailable'));

      await collect(
        await service.execute(SESSION_ID, 'MCP server for JSONPlaceholder', CONVERSATION_ID, USER_ID),
      );

      const failed = pipelineRunRepo.rows.filter((r) => r.status === 'failed');
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ step: 'refine', error: 'docker unavailable' });
      expect(failed[0].durationMs).toBeGreaterThanOrEqual(0);
    });

    it('does not let a clarification failure block generation', async () => {
      clarificationService.orchestrateClarification.mockRejectedValue(new Error('judge down'));

      const updates = await collect(
        await service.execute(SESSION_ID, 'MCP server for JSONPlaceholder', CONVERSATION_ID, USER_ID),
      );

      const final = updates[updates.length - 1];
      expect(final.error).toBeUndefined();
      expect(refinementService.refineUntilWorking).toHaveBeenCalled();
      expect(progressMessages(updates)).toContain('Clarification skipped: judge down');
    });

    it('keeps partial success when refinement runs out of iterations', async () => {
      refinementService.refineUntilWorking.mockResolvedValue({
        success: false,
        generatedCode: generatedCode(),
        testResults: { ...createMockTestResults(false, 3), toolsPassedCount: 2 },
        failureAnalysis: { fixes: [] },
        iterations: 5,
        shouldContinue: false,
        error: 'Failed to converge after 5 iterations.',
      });

      const updates = await collect(
        await service.execute(SESSION_ID, 'MCP server for JSONPlaceholder', CONVERSATION_ID, USER_ID),
      );

      const final = updates[updates.length - 1];
      expect(final.isComplete).toBe(true);
      expect(final.response).toContain('partial success');
      expect(final.response).toContain('2/3 tools working');
      // Partial results are still persisted for deployment
      expect(existsSync(join(generatedDir, CONVERSATION_ID, 'src', 'index.ts'))).toBe(true);
    });

    it('loops refinement until it stops asking to continue', async () => {
      refinementService.refineUntilWorking
        .mockResolvedValueOnce({
          success: false,
          generatedCode: generatedCode(),
          testResults: createMockTestResults(false, 1),
          failureAnalysis: { fixes: [{ toolName: 'list_posts' }] },
          iterations: 1,
          shouldContinue: true,
        })
        .mockResolvedValueOnce({
          success: true,
          generatedCode: generatedCode(),
          testResults: createMockTestResults(true, 1),
          iterations: 2,
          shouldContinue: false,
        });

      const updates = await collect(
        await service.execute(SESSION_ID, 'MCP server for JSONPlaceholder', CONVERSATION_ID, USER_ID),
      );

      expect(refinementService.refineUntilWorking).toHaveBeenCalledTimes(2);
      expect(progressMessages(updates)).toContain('Refining code based on 1 fixes...');
      expect(updates[updates.length - 1].response).toContain('Successfully generated');
    });
  });

  // -------------------------------------------------------------------------

  describe('quota enforcement', () => {
    it('blocks generation before research when the monthly quota is exhausted', async () => {
      userService.checkCanGenerate.mockResolvedValue({
        allowed: false,
        reason:
          "You've reached your Free tier limit of 5 MCP server generations this month. " +
          'Upgrade to Pro for unlimited generations.',
      });

      const updates = await collect(
        await service.execute(SESSION_ID, 'MCP server for JSONPlaceholder', CONVERSATION_ID, USER_ID),
      );

      const final = updates[updates.length - 1];
      expect(final.isComplete).toBe(true);
      expect(final.response).toContain('Free tier limit of 5 MCP server generations');
      expect(
        progressMessages(updates).some((m) =>
          m.includes('Free tier limit of 5 MCP server generations'),
        ),
      ).toBe(true);

      // No expensive work started
      expect(researchService.conductResearch).not.toHaveBeenCalled();
      expect(refinementService.refineUntilWorking).not.toHaveBeenCalled();

      // The response is persisted like any other assistant reply
      expect(conversationRepo.row.messages.map((m: any) => m.role)).toEqual(['user', 'assistant']);

      expect(userService.checkCanGenerate).toHaveBeenCalledWith(USER_ID);
    });

    it('never blocks a help request even when quota is exhausted', async () => {
      userService.checkCanGenerate.mockResolvedValue({
        allowed: false,
        reason: 'quota exhausted',
      });
      respondWith({ intent: intentResponse({ intent: 'help' }) });

      const updates = await collect(
        await service.execute(SESSION_ID, 'what can you do?', CONVERSATION_ID, USER_ID),
      );

      const final = updates[updates.length - 1];
      expect(final.isComplete).toBe(true);
      expect(final.response).toContain('MCP Everything');
      expect(userService.checkCanGenerate).not.toHaveBeenCalled();
    });

    it('never blocks a clarification-needed reply even when quota is exhausted', async () => {
      userService.checkCanGenerate.mockResolvedValue({
        allowed: false,
        reason: 'quota exhausted',
      });
      respondWith({
        intent: intentResponse({ intent: 'unknown', missingInfo: ['which service'] }),
      });

      const updates = await collect(
        await service.execute(SESSION_ID, 'make me a thing', CONVERSATION_ID, USER_ID),
      );

      const final = updates[updates.length - 1];
      expect(final.needsUserInput).toBe(true);
      expect(final.response).toContain('which service');
      expect(userService.checkCanGenerate).not.toHaveBeenCalled();
    });

    /**
     * The check used to sit inside the `if (!resumed)` branch, so a user at
     * their limit could resume any paused conversation and generate for free.
     */
    it('blocks a resumed run when the quota is exhausted', async () => {
      clarificationService.orchestrateClarification
        .mockResolvedValueOnce({
          complete: false,
          needsUserInput: true,
          gaps: [{ issue: 'Base URL unknown', priority: 'HIGH', suggestedQuestion: 'URL?', context: 'c' }],
          questions: [{ question: 'URL?', context: 'c', required: true }],
        })
        .mockResolvedValue({ complete: true, gaps: [], needsUserInput: false });

      await collect(
        await service.execute(SESSION_ID, 'MCP server for MyCustomAPI', CONVERSATION_ID, USER_ID),
      );
      expect(userService.checkCanGenerate).toHaveBeenCalledTimes(1);

      // The user hits their limit between turns
      userService.checkCanGenerate.mockResolvedValue({
        allowed: false,
        reason: "You've reached your Free tier limit of 5 MCP server generations this month.",
      });

      const updates = await collect(
        await service.execute(SESSION_ID, 'https://api.example.com', CONVERSATION_ID, USER_ID),
      );

      const final = updates[updates.length - 1];
      expect(final.isComplete).toBe(true);
      expect(final.response).toContain('Free tier limit of 5 MCP server generations');
      expect(userService.checkCanGenerate).toHaveBeenCalledTimes(2);

      // The resumed run never reached the expensive steps
      expect(refinementService.refineUntilWorking).not.toHaveBeenCalled();
      expect(userService.incrementUsage).not.toHaveBeenCalled();
      expect(pipelineRunRepo.rows.map((r) => r.step)).not.toContain('refine');
    });

    it('lets a resumed run through when the user is still within quota', async () => {
      clarificationService.orchestrateClarification
        .mockResolvedValueOnce({
          complete: false,
          needsUserInput: true,
          gaps: [{ issue: 'Base URL unknown', priority: 'HIGH', suggestedQuestion: 'URL?', context: 'c' }],
          questions: [{ question: 'URL?', context: 'c', required: true }],
        })
        .mockResolvedValue({ complete: true, gaps: [], needsUserInput: false });

      await collect(
        await service.execute(SESSION_ID, 'MCP server for MyCustomAPI', CONVERSATION_ID, USER_ID),
      );

      const updates = await collect(
        await service.execute(SESSION_ID, 'https://api.example.com', CONVERSATION_ID, USER_ID),
      );

      expect(updates[updates.length - 1].response).toContain('Successfully generated');
      expect(userService.checkCanGenerate).toHaveBeenCalledTimes(2);
      expect(userService.incrementUsage).toHaveBeenCalledTimes(1);
    });

    it('records usage exactly once when a generation completes successfully', async () => {
      await collect(
        await service.execute(SESSION_ID, 'MCP server for JSONPlaceholder', CONVERSATION_ID, USER_ID),
      );

      expect(userService.incrementUsage).toHaveBeenCalledTimes(1);
      expect(userService.incrementUsage).toHaveBeenCalledWith(USER_ID);
    });

    it('does not record usage on a bare attempt (quota exceeded before any work runs)', async () => {
      userService.checkCanGenerate.mockResolvedValue({ allowed: false, reason: 'no quota' });

      await collect(
        await service.execute(SESSION_ID, 'MCP server for JSONPlaceholder', CONVERSATION_ID, USER_ID),
      );

      expect(userService.incrementUsage).not.toHaveBeenCalled();
    });

    it('does not record usage when refinement only reaches partial success', async () => {
      refinementService.refineUntilWorking.mockResolvedValue({
        success: false,
        generatedCode: generatedCode(),
        testResults: { ...createMockTestResults(false, 3), toolsPassedCount: 2 },
        failureAnalysis: { fixes: [] },
        iterations: 5,
        shouldContinue: false,
        error: 'Failed to converge after 5 iterations.',
      });

      await collect(
        await service.execute(SESSION_ID, 'MCP server for JSONPlaceholder', CONVERSATION_ID, USER_ID),
      );

      expect(userService.incrementUsage).not.toHaveBeenCalled();
    });

    it('is a no-op (fails open) when the pipeline runs without a known user', async () => {
      const updates = await collect(
        await service.execute(SESSION_ID, 'MCP server for JSONPlaceholder', CONVERSATION_ID, undefined),
      );

      expect(updates[updates.length - 1].isComplete).toBe(true);
      expect(userService.checkCanGenerate).not.toHaveBeenCalled();
      expect(userService.incrementUsage).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------

  describe('conversation ownership', () => {
    it('refuses a conversation owned by another user', async () => {
      await expect(
        service.execute(SESSION_ID, 'hello', CONVERSATION_ID, 'someone-else'),
      ).rejects.toThrow(NotFoundException);
      expect(researchService.conductResearch).not.toHaveBeenCalled();
    });

    it('creates a conversation owned by the caller when none is supplied', async () => {
      const id = await service.ensureConversation('fresh-session', undefined, 'new-user');

      expect(id).toBe(CONVERSATION_ID);
      expect(conversationRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'fresh-session', userId: 'new-user' }),
      );
    });

    it('returns the existing conversation id for its owner', async () => {
      await expect(
        service.ensureConversation(SESSION_ID, CONVERSATION_ID, USER_ID),
      ).resolves.toBe(CONVERSATION_ID);
      expect(conversationRepo.create).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------

  describe('observability', () => {
    it('records one succeeded pipeline_runs row per executed step', async () => {
      await collect(
        await service.execute(SESSION_ID, 'MCP server for JSONPlaceholder', CONVERSATION_ID, USER_ID),
      );

      expect(pipelineRunRepo.rows.map((r) => r.step)).toEqual([
        'analyzeIntent',
        'research',
        'planTools',
        'clarify',
        'refine',
        'persist',
      ]);
      expect(pipelineRunRepo.rows.every((r) => r.status === 'succeeded')).toBe(true);
      expect(pipelineRunRepo.rows.every((r) => r.conversationId === CONVERSATION_ID)).toBe(true);
      expect(pipelineRunRepo.rows.every((r) => typeof r.durationMs === 'number')).toBe(true);

      const planRow = pipelineRunRepo.rows.find((r) => r.step === 'planTools');
      expect(planRow.outputSummary).toBe('Planned 1 tools: list_posts');
      const refineRow = pipelineRunRepo.rows.find((r) => r.step === 'refine');
      expect(refineRow.outputSummary).toContain('1/1 tools passing');
    });

    it('survives a pipeline_runs write failure', async () => {
      pipelineRunRepo.save.mockRejectedValue(new Error('table missing'));

      const updates = await collect(
        await service.execute(SESSION_ID, 'MCP server for JSONPlaceholder', CONVERSATION_ID, USER_ID),
      );

      expect(updates[updates.length - 1].isComplete).toBe(true);
      expect(updates[updates.length - 1].error).toBeUndefined();
    });
  });
});
