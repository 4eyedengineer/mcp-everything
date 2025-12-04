import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StateGraph, END, START, Annotation, CompiledStateGraph } from '@langchain/langgraph';
import { ChatAnthropic } from '@langchain/anthropic';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Conversation, ConversationMemory } from '../database/entities';
import { GraphState, NodeResult } from './types';
import { GitHubAnalysisService } from '../github-analysis.service';
import { CodeExecutionService } from './code-execution.service';
import { ResearchService } from './research.service';
import { EnsembleService } from './ensemble.service';
import { ClarificationService } from './clarification.service';
import { RefinementService } from './refinement.service';
import { getPlatformContextPrompt } from './platform-context';
import { safeParseJSON } from './json-utils';

/**
 * LangGraph Orchestration Service
 * Handles dynamic conversation flow with branching logic
 */
@Injectable()
export class GraphOrchestrationService {
  private readonly logger = new Logger(GraphOrchestrationService.name);
  private graph: CompiledStateGraph<any, any, any, any>;
  private llm: ChatAnthropic;

  constructor(
    private configService: ConfigService,
    @InjectRepository(Conversation)
    private conversationRepo: Repository<Conversation>,
    @InjectRepository(ConversationMemory)
    private memoryRepo: Repository<ConversationMemory>,
    private githubAnalysisService: GitHubAnalysisService,
    private codeExecutionService: CodeExecutionService,
    // Ensemble architecture services
    private researchService: ResearchService,
    private ensembleService: EnsembleService,
    private clarificationService: ClarificationService,
    private refinementService: RefinementService,
  ) {
    this.initializeLLM();
    this.buildGraph();
  }

  /**
   * Initialize Anthropic LLM
   */
  private initializeLLM(): void {
    const apiKey = this.configService.get<string>('ANTHROPIC_API_KEY');
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY not configured');
    }

    this.llm = new ChatAnthropic({
      apiKey,
      model: 'claude-haiku-4-5-20251001', // Using Haiku for cost-effective processing
      temperature: 0.7,
      topP: undefined, // Fix for @langchain/anthropic bug sending top_p: -1
      streaming: true,
    });

    this.logger.log('Anthropic LLM initialized');
  }

  /**
   * Build LangGraph state machine
   */
  private buildGraph(): void {
    // Define state annotation
    const StateAnnotation = Annotation.Root({
      sessionId: Annotation<string>,
      conversationId: Annotation<string>,
      messages: Annotation<GraphState['messages']>,
      userInput: Annotation<string>,
      intent: Annotation<GraphState['intent']>,
      extractedData: Annotation<GraphState['extractedData']>,
      researchResults: Annotation<GraphState['researchResults']>,
      generationPlan: Annotation<GraphState['generationPlan']>,
      generatedCode: Annotation<GraphState['generatedCode']>,
      executionResults: Annotation<GraphState['executionResults']>,
      clarificationNeeded: Annotation<GraphState['clarificationNeeded']>,
      response: Annotation<string>,
      currentNode: Annotation<string>,
      executedNodes: Annotation<string[]>,
      needsUserInput: Annotation<boolean>,
      isComplete: Annotation<boolean>,
      error: Annotation<string>,
      streamingUpdates: Annotation<GraphState['streamingUpdates']>,
      // NEW: Ensemble architecture fields
      researchPhase: Annotation<GraphState['researchPhase']>,
      ensembleResults: Annotation<GraphState['ensembleResults']>,
      clarificationHistory: Annotation<GraphState['clarificationHistory']>,
      clarificationComplete: Annotation<boolean>,
      refinementIteration: Annotation<number>,
      refinementHistory: Annotation<GraphState['refinementHistory']>,
    });

    // Create graph
    const workflow = new StateGraph(StateAnnotation)
      // EXISTING NODES
      // Node: Analyze user intent
      .addNode('analyzeIntent', this.analyzeIntent.bind(this))

      // Node: Ask clarifying questions
      .addNode('clarifyWithUser', this.clarifyWithUser.bind(this))

      // Node: Provide help/guidance
      .addNode('provideHelp', this.provideHelp.bind(this))

      // Node: Handle errors
      .addNode('handleError', this.handleError.bind(this))

      // NEW ENSEMBLE NODES
      // Node: Phase 1 - Research & Planning
      .addNode('researchCoordinator', this.researchCoordinator.bind(this))

      // Node: Phase 2 - Parallel Reasoning & Voting
      .addNode('ensembleCoordinator', this.ensembleCoordinator.bind(this))

      // Node: Phase 3 - Iterative Clarification
      .addNode('clarificationOrchestrator', this.clarificationOrchestrator.bind(this))

      // Node: Phase 4 - Generate-Test-Refine Loop
      .addNode('refinementLoop', this.refinementLoop.bind(this));

    // Define edges (routing logic)
    workflow.addEdge(START, 'analyzeIntent');

    // From analyzeIntent, route based on intent
    workflow.addConditionalEdges('analyzeIntent', this.routeFromIntent.bind(this));

    // From clarification, back to intent analysis
    workflow.addEdge('clarifyWithUser', END);

    // Help and error always end
    workflow.addEdge('provideHelp', END);
    workflow.addEdge('handleError', END);

    // NEW ENSEMBLE WORKFLOW EDGES
    // From research coordinator, go to ensemble coordinator
    workflow.addConditionalEdges('researchCoordinator', this.routeFromResearch.bind(this));

    // From ensemble coordinator, check consensus and route
    workflow.addConditionalEdges('ensembleCoordinator', this.routeFromEnsemble.bind(this));

    // From clarification orchestrator, either loop back or proceed
    workflow.addConditionalEdges(
      'clarificationOrchestrator',
      this.routeFromClarification.bind(this),
    );

    // From refinement loop, either continue iteration or finish
    workflow.addConditionalEdges('refinementLoop', this.routeFromRefinement.bind(this));

    this.graph = workflow.compile();
    this.logger.log('LangGraph state machine built successfully');
  }

  /**
   * Execute graph for a user message
   */
  async executeGraph(
    sessionId: string,
    userInput: string,
    conversationId?: string,
  ): Promise<AsyncGenerator<Partial<GraphState>>> {
    try {
      // Load or create conversation
      const conversation = await this.loadOrCreateConversation(sessionId, conversationId);

      // Save user message to conversation immediately
      await this.saveMessageToConversation(conversation.id, {
        role: 'user',
        content: userInput,
        timestamp: new Date(),
      });

      // Reload conversation to get updated messages
      const updatedConversation = await this.conversationRepo.findOne({
        where: { id: conversation.id },
      });

      // Initial state
      const initialState: GraphState = {
        sessionId,
        conversationId: conversation.id,
        messages: updatedConversation?.messages || [],
        userInput,
        currentNode: 'analyzeIntent',
        executedNodes: [],
        needsUserInput: false,
        isComplete: false,
        streamingUpdates: [],
      };

      // Execute graph with streaming
      const stream = await this.graph.stream(initialState);

      return this.processGraphStream(stream, conversation.id);
    } catch (error) {
      this.logger.error(`Graph execution failed: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * Process graph stream and yield updates
   */
  private async *processGraphStream(
    stream: AsyncGenerator<any>,
    conversationId: string,
  ): AsyncGenerator<Partial<GraphState>> {
    for await (const update of stream) {
      // LangGraph yields updates as { nodeName: partialState }
      // Extract the actual state from the update
      const nodeNames = Object.keys(update);

      for (const nodeName of nodeNames) {
        const partialState = update[nodeName];

        // Merge with conversationId
        const fullUpdate = {
          ...partialState,
          conversationId,
        };

        // Save checkpoint to database
        await this.saveCheckpoint(conversationId, fullUpdate);

        // Save AI response to conversation if present
        if (partialState.response && partialState.isComplete) {
          await this.saveMessageToConversation(conversationId, {
            role: 'assistant',
            content: partialState.response,
            timestamp: new Date(),
          });
        }

        // Yield update for SSE streaming
        yield fullUpdate;
      }
    }
  }

  /**
   * Node: Analyze user intent
   */
  private async analyzeIntent(state: GraphState): Promise<Partial<GraphState>> {
    this.logger.log('Executing node: analyzeIntent');

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
${state.messages.slice(-3).map(m => `${m.role}: ${m.content}`).join('\n')}

**Task**: Determine primary intent with confidence. When the user mentions "MCP server" or "MCP" in any context, they mean Model Context Protocol server - a tool for extending LLM capabilities.

**Inference Guidelines:**
- If user mentions a service/API (Stripe, GitHub, etc.) + "MCP", they want a Model Context Protocol server for that service
- MCP = Model Context Protocol ONLY (not Minecraft, not Merchant anything)
- If user asks "how to" or "explain", intent is likely \`research\` or \`help\`
- Default to TypeScript unless user specifies another language
- Only flag missing info if it's CRITICAL and cannot be inferred

**Response Format** (JSON):
{
  "intent": "generate_mcp|clarify|research|help|unknown",
  "confidence": 0.0-1.0,
  "githubUrl": "URL or null",
  "missingInfo": ["ONLY critical blockers"] or null,
  "reasoning": "brief explanation - mention understanding MCP means Model Context Protocol if relevant"
}`;

    const response = await this.llm.invoke(prompt);

    // Extract JSON from response using safe bracket-balanced parsing
    const analysis = safeParseJSON<{
      intent: 'generate_mcp' | 'clarify' | 'research' | 'help' | 'unknown';
      confidence: number;
      githubUrl: string | null;
      missingInfo: string[] | null;
      reasoning: string;
    }>(response.content as string, this.logger);

    return {
      intent: {
        type: analysis.intent,
        confidence: analysis.confidence,
        reasoning: analysis.reasoning,
      },
      extractedData: {
        githubUrl: analysis.githubUrl,
      },
      clarificationNeeded: analysis.missingInfo?.length > 0 ? {
        question: `I need more information: ${analysis.missingInfo.join(', ')}`,
        context: 'intent_analysis',
      } : undefined,
      currentNode: 'analyzeIntent',
      executedNodes: [...(state.executedNodes || []), 'analyzeIntent'],
      streamingUpdates: [
        ...(state.streamingUpdates || []),
        {
          node: 'analyzeIntent',
          message: `Analyzed intent: ${analysis.intent} (confidence: ${analysis.confidence})`,
          timestamp: new Date(),
        },
      ],
    };
  }

  /**
   * Node: Clarify with user
   */
  private async clarifyWithUser(state: GraphState): Promise<Partial<GraphState>> {
    this.logger.log('Executing node: clarifyWithUser');

    return {
      response: state.clarificationNeeded?.question || 'Could you provide more details?',
      currentNode: 'clarifyWithUser',
      executedNodes: [...(state.executedNodes || []), 'clarifyWithUser'],
      needsUserInput: true,
      isComplete: true, // Will resume on next user message
    };
  }

  /**
   * Node: Provide help
   */
  private async provideHelp(state: GraphState): Promise<Partial<GraphState>> {
    this.logger.log('Executing node: provideHelp');

    return {
      response: `I'm the AI assistant for MCP Everything, a platform that generates Model Context Protocol (MCP) servers from any input.

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

What would you like to create?`,
      currentNode: 'provideHelp',
      executedNodes: [...(state.executedNodes || []), 'provideHelp'],
      isComplete: true,
    };
  }

  /**
   * Node: Handle errors
   */
  private async handleError(state: GraphState): Promise<Partial<GraphState>> {
    this.logger.error(`Error in graph execution: ${state.error}`);

    return {
      response: `I encountered an error: ${state.error}. Please try again or rephrase your request.`,
      currentNode: 'handleError',
      executedNodes: [...(state.executedNodes || []), 'handleError'],
      isComplete: true,
    };
  }

  /**
   * NEW ENSEMBLE NODES
   */

  /**
   * Node: Research Coordinator (Phase 1)
   * Conducts web search, GitHub deep analysis, API documentation research
   */
  private async researchCoordinator(state: GraphState): Promise<Partial<GraphState>> {
    this.logger.log('Executing node: researchCoordinator');

    const streamingUpdates = [...(state.streamingUpdates || [])];

    try {
      streamingUpdates.push({
        node: 'researchCoordinator',
        message: 'Starting comprehensive research phase...',
        timestamp: new Date(),
      });

      // Call ResearchService
      const researchPhase = await this.researchService.conductResearch(state as GraphState);

      streamingUpdates.push({
        node: 'researchCoordinator',
        message: `Research complete: confidence ${researchPhase.researchConfidence.toFixed(2)}`,
        timestamp: new Date(),
      });

      return {
        researchPhase,
        currentNode: 'researchCoordinator',
        executedNodes: [...(state.executedNodes || []), 'researchCoordinator'],
        streamingUpdates,
      };
    } catch (error) {
      this.logger.error(`Research coordination failed: ${error.message}`);

      return {
        error: `Research failed: ${error.message}`,
        currentNode: 'researchCoordinator',
        executedNodes: [...(state.executedNodes || []), 'researchCoordinator'],
        streamingUpdates: [
          ...streamingUpdates,
          {
            node: 'researchCoordinator',
            message: `Error: ${error.message}`,
            timestamp: new Date(),
          },
        ],
      };
    }
  }

  /**
   * Node: Ensemble Coordinator (Phase 2)
   * Runs 4 specialist agents in parallel with weighted voting
   */
  private async ensembleCoordinator(state: GraphState): Promise<Partial<GraphState>> {
    this.logger.log('Executing node: ensembleCoordinator');

    const streamingUpdates = [...(state.streamingUpdates || [])];

    try {
      streamingUpdates.push({
        node: 'ensembleCoordinator',
        message: 'Running ensemble of 4 specialist agents...',
        timestamp: new Date(),
      });

      // Call EnsembleService
      const ensembleResults = await this.ensembleService.orchestrateEnsemble(state as GraphState);

      streamingUpdates.push({
        node: 'ensembleCoordinator',
        message: `Ensemble complete: consensus ${ensembleResults.consensusScore.toFixed(2)}`,
        timestamp: new Date(),
      });

      return {
        ensembleResults,
        generationPlan: ensembleResults.consensus, // Use consensus from ensemble results
        currentNode: 'ensembleCoordinator',
        executedNodes: [...(state.executedNodes || []), 'ensembleCoordinator'],
        streamingUpdates,
      };
    } catch (error) {
      this.logger.error(`Ensemble coordination failed: ${error.message}`);

      return {
        error: `Ensemble failed: ${error.message}`,
        currentNode: 'ensembleCoordinator',
        executedNodes: [...(state.executedNodes || []), 'ensembleCoordinator'],
        streamingUpdates: [
          ...streamingUpdates,
          {
            node: 'ensembleCoordinator',
            message: `Error: ${error.message}`,
            timestamp: new Date(),
          },
        ],
      };
    }
  }

  /**
   * Node: Clarification Orchestrator (Phase 3)
   * AI-powered gap detection and iterative clarification
   */
  private async clarificationOrchestrator(state: GraphState): Promise<Partial<GraphState>> {
    this.logger.log('Executing node: clarificationOrchestrator');

    const streamingUpdates = [...(state.streamingUpdates || [])];

    try {
      streamingUpdates.push({
        node: 'clarificationOrchestrator',
        message: 'Analyzing for knowledge gaps...',
        timestamp: new Date(),
      });

      // Call ClarificationService
      const clarificationResult = await this.clarificationService.orchestrateClarification(
        state as GraphState,
      );

      if (clarificationResult.needsUserInput) {
        // Formulate clarification questions
        const questionsText = clarificationResult.questions
          ?.map((q, i) => `${i + 1}. ${q.question}\n   Context: ${q.context}`)
          .join('\n\n');

        streamingUpdates.push({
          node: 'clarificationOrchestrator',
          message: `Clarification needed: ${clarificationResult.gaps.length} gaps detected`,
          timestamp: new Date(),
        });

        return {
          clarificationNeeded: {
            question: `I need some clarifications:\n\n${questionsText}`,
            context: 'ensemble_clarification',
          },
          clarificationHistory: [
            ...(state.clarificationHistory || []),
            {
              gaps: clarificationResult.gaps,
              questions: clarificationResult.questions || [],
              timestamp: new Date(),
            },
          ],
          clarificationComplete: false,
          currentNode: 'clarificationOrchestrator',
          executedNodes: [...(state.executedNodes || []), 'clarificationOrchestrator'],
          needsUserInput: true,
          isComplete: true,
          streamingUpdates,
        };
      }

      // No clarification needed, proceed
      streamingUpdates.push({
        node: 'clarificationOrchestrator',
        message: 'No clarification needed, proceeding to refinement',
        timestamp: new Date(),
      });

      return {
        clarificationComplete: true,
        currentNode: 'clarificationOrchestrator',
        executedNodes: [...(state.executedNodes || []), 'clarificationOrchestrator'],
        streamingUpdates,
      };
    } catch (error) {
      this.logger.error(`Clarification orchestration failed: ${error.message}`);

      // If clarification fails, proceed anyway
      return {
        clarificationComplete: true,
        currentNode: 'clarificationOrchestrator',
        executedNodes: [...(state.executedNodes || []), 'clarificationOrchestrator'],
        streamingUpdates: [
          ...streamingUpdates,
          {
            node: 'clarificationOrchestrator',
            message: `Clarification skipped: ${error.message}`,
            timestamp: new Date(),
          },
        ],
      };
    }
  }

  /**
   * Node: Refinement Loop (Phase 4)
   * Generate-Test-Refine iteration until all tools work
   */
  private async refinementLoop(state: GraphState): Promise<Partial<GraphState>> {
    this.logger.log('Executing node: refinementLoop');

    const streamingUpdates = [...(state.streamingUpdates || [])];
    const iteration = (state.refinementIteration || 0) + 1;

    try {
      streamingUpdates.push({
        node: 'refinementLoop',
        message: `Starting refinement iteration ${iteration}/5...`,
        timestamp: new Date(),
      });

      // Call RefinementService
      const refinementResult = await this.refinementService.refineUntilWorking(state as GraphState);

      streamingUpdates.push({
        node: 'refinementLoop',
        message: `Iteration ${iteration}: ${refinementResult.testResults.toolsPassedCount}/${refinementResult.testResults.toolsFound} tools passing`,
        timestamp: new Date(),
      });

      // Update refinement history
      const refinementHistory = [
        ...(state.refinementHistory || []),
        {
          iteration: refinementResult.iterations,
          testResults: refinementResult.testResults,
          failureAnalysis: refinementResult.failureAnalysis!,
          timestamp: new Date(),
        },
      ];

      if (refinementResult.success) {
        // All tools work!
        streamingUpdates.push({
          node: 'refinementLoop',
          message: `✅ Success! All ${refinementResult.testResults.toolsPassedCount} tools working`,
          timestamp: new Date(),
        });

        return {
          generatedCode: refinementResult.generatedCode,
          refinementIteration: refinementResult.iterations,
          refinementHistory,
          response: `✅ Successfully generated and tested MCP server!

**All ${refinementResult.testResults.toolsPassedCount} tools validated**
- Build: ✓ Success
- MCP Protocol: ✓ Compliant
- Runtime: ✓ No errors

Iterations needed: ${refinementResult.iterations}/5`,
          currentNode: 'refinementLoop',
          executedNodes: [...(state.executedNodes || []), 'refinementLoop'],
          isComplete: true,
          streamingUpdates,
        };
      }

      if (!refinementResult.shouldContinue) {
        // Max iterations reached
        streamingUpdates.push({
          node: 'refinementLoop',
          message: `⚠️ Max iterations reached: ${refinementResult.testResults.toolsPassedCount}/${refinementResult.testResults.toolsFound} tools working`,
          timestamp: new Date(),
        });

        return {
          generatedCode: refinementResult.generatedCode,
          refinementIteration: refinementResult.iterations,
          refinementHistory,
          response: `⚠️ Refinement completed with partial success:

**${refinementResult.testResults.toolsPassedCount}/${refinementResult.testResults.toolsFound} tools working**
- Build: ${refinementResult.testResults.buildSuccess ? '✓' : '✗'}
- Iterations: ${refinementResult.iterations}/5

${refinementResult.error || 'Some tools may need manual fixes.'}`,
          currentNode: 'refinementLoop',
          executedNodes: [...(state.executedNodes || []), 'refinementLoop'],
          isComplete: true,
          streamingUpdates,
        };
      }

      // Continue iteration
      streamingUpdates.push({
        node: 'refinementLoop',
        message: `Refining code based on ${refinementResult.failureAnalysis?.fixes.length || 0} fixes...`,
        timestamp: new Date(),
      });

      return {
        generatedCode: refinementResult.generatedCode,
        refinementIteration: refinementResult.iterations,
        refinementHistory,
        currentNode: 'refinementLoop',
        executedNodes: [...(state.executedNodes || []), 'refinementLoop'],
        streamingUpdates,
      };
    } catch (error) {
      this.logger.error(`Refinement loop failed: ${error.message}`);

      return {
        error: `Refinement failed: ${error.message}`,
        currentNode: 'refinementLoop',
        executedNodes: [...(state.executedNodes || []), 'refinementLoop'],
        isComplete: true,
        streamingUpdates: [
          ...streamingUpdates,
          {
            node: 'refinementLoop',
            message: `Error: ${error.message}`,
            timestamp: new Date(),
          },
        ],
      };
    }
  }

  /**
   * Routing: From intent analysis
   */
  private routeFromIntent(state: GraphState): string {
    if (state.error) return 'handleError';

    if (state.clarificationNeeded) return 'clarifyWithUser';

    switch (state.intent?.type) {
      case 'generate_mcp':
        // NEW: Route to ensemble architecture for ANY input (GitHub URL, website, service name, natural language)
        // ResearchService now handles input classification internally
        return 'researchCoordinator';
      case 'help':
        return 'provideHelp';
      case 'research':
        return 'researchCoordinator';
      case 'clarify':
        // User is responding to a clarification request - re-run research with new context
        return 'researchCoordinator';
      default:
        return 'clarifyWithUser';
    }
  }

  /**
   * NEW ENSEMBLE ROUTING FUNCTIONS
   */

  /**
   * Routing: From research coordinator
   */
  private routeFromResearch(state: GraphState): string {
    if (state.error) return 'handleError';

    // Check if research was successful
    if (state.researchPhase?.researchConfidence > 0.5) {
      return 'ensembleCoordinator';
    }

    // If research failed or low confidence, ask for clarification
    return 'clarifyWithUser';
  }

  /**
   * Routing: From ensemble coordinator
   */
  private routeFromEnsemble(state: GraphState): string {
    if (state.error) return 'handleError';

    // Check consensus score
    const consensusScore = state.ensembleResults?.consensusScore || 0;

    // If low consensus (< 0.7), go to clarification
    if (consensusScore < 0.7) {
      return 'clarificationOrchestrator';
    }

    // High consensus, proceed to refinement
    return 'clarificationOrchestrator'; // Always check for gaps first
  }

  /**
   * Routing: From clarification orchestrator
   */
  private routeFromClarification(state: GraphState): string {
    if (state.error) return 'handleError';

    // If needs user input, pause execution
    if (state.needsUserInput && state.clarificationNeeded) {
      return 'clarifyWithUser';
    }

    // Clarification complete, proceed to refinement
    return 'refinementLoop';
  }

  /**
   * Routing: From refinement loop
   */
  private routeFromRefinement(state: GraphState): string {
    if (state.error) return 'handleError';

    // Check if complete
    if (state.isComplete) {
      return END;
    }

    // Check if should continue iteration
    const iteration = state.refinementIteration || 0;
    const maxIterations = 5;

    if (iteration < maxIterations) {
      // Continue refinement loop
      return 'refinementLoop';
    }

    // Max iterations reached, end
    return END;
  }

  /**
   * Load or create conversation from database
   */
  private async loadOrCreateConversation(
    sessionId: string,
    conversationId?: string,
  ): Promise<Conversation> {
    if (conversationId) {
      const existing = await this.conversationRepo.findOne({
        where: { id: conversationId, sessionId },
      });
      if (existing) return existing;
    }

    // Create new conversation
    const conversation = this.conversationRepo.create({
      sessionId,
      messages: [],
      state: {},
      isActive: true,
    });

    return await this.conversationRepo.save(conversation);
  }

  /**
   * Save checkpoint to database
   */
  private async saveCheckpoint(
    conversationId: string,
    state: Partial<GraphState>,
  ): Promise<void> {
    const checkpoint = this.memoryRepo.create({
      conversationId,
      checkpointId: `checkpoint-${Date.now()}`,
      graphState: state as any,
      currentNode: state.currentNode || 'unknown',
      executedNodes: state.executedNodes || [],
      isCompleted: state.isComplete || false,
    });

    await this.memoryRepo.save(checkpoint);
  }

  /**
   * Save a message to the conversation's messages array
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
    const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
    messages.push(message);

    // Generate title from first user message if messages were empty
    const updateData: any = {
      messages,
      updatedAt: new Date(),
    };

    // If this is the first user message, update the title
    if (message.role === 'user' && messages.filter(m => m.role === 'user').length === 1) {
      const title = message.content.substring(0, 50) + (message.content.length > 50 ? '...' : '');
      updateData.state = {
        ...conversation.state,
        metadata: {
          ...(conversation.state?.metadata || {}),
          title,
        },
      };
      this.logger.log(`Set conversation title to: "${title}"`);
    }

    // Update conversation with new messages
    await this.conversationRepo.update(conversationId, updateData);

    this.logger.log(`Saved ${message.role} message to conversation ${conversationId}`);
  }
}
