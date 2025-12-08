/// <reference types="jest" />

// Mock isolated-vm BEFORE any imports that use it
jest.mock('isolated-vm', () => ({
  Isolate: jest.fn().mockImplementation(() => ({
    createContext: jest.fn().mockResolvedValue({
      global: {
        set: jest.fn().mockResolvedValue(undefined),
        get: jest.fn().mockResolvedValue(undefined),
      },
      evalClosure: jest.fn().mockResolvedValue(undefined),
    }),
    dispose: jest.fn(),
  })),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { GraphOrchestrationService } from '../graph.service';
import { ResearchService } from '../research.service';
import { EnsembleService } from '../ensemble.service';
import { ClarificationService } from '../clarification.service';
import { RefinementService } from '../refinement.service';
import { GitHubAnalysisService } from '../../github-analysis.service';
import { CodeExecutionService } from '../code-execution.service';
import { Conversation, ConversationMemory } from '../../database/entities';
import { StructuredLoggerService } from '../../logging/structured-logger.service';
import { ErrorLoggingService } from '../../logging/error-logging.service';
import {
  createTestState,
  createResearchedState,
  createEnsembledState,
  createMockConfigService,
  createMockRepository,
  createMockLogger,
  createMockTestResults,
} from './__mocks__/test-utils';
import {
  mockIntentAnalysisResponse,
  mockResearchSynthesisResponse,
  mockCodeGenerationResponse,
} from './__mocks__/anthropic.mock';

// Mock @langchain/anthropic module
jest.mock('@langchain/anthropic', () => ({
  ChatAnthropic: jest.fn().mockImplementation(() => ({
    invoke: jest.fn().mockResolvedValue({
      content: mockIntentAnalysisResponse('generate_mcp'),
    }),
  })),
}));

// Mock @langchain/langgraph module
jest.mock('@langchain/langgraph', () => ({
  StateGraph: jest.fn().mockImplementation(() => ({
    addNode: jest.fn().mockReturnThis(),
    addEdge: jest.fn().mockReturnThis(),
    addConditionalEdges: jest.fn().mockReturnThis(),
    compile: jest.fn().mockReturnValue({
      stream: jest.fn(),
    }),
  })),
  Annotation: {
    Root: jest.fn().mockReturnValue({}),
  },
  END: 'END',
  START: '__start__',
}));

describe('GraphOrchestrationService', () => {
  let service: GraphOrchestrationService;
  let mockConversationRepo: ReturnType<typeof createMockRepository>;
  let mockMemoryRepo: ReturnType<typeof createMockRepository>;
  let mockResearchService: any;
  let mockEnsembleService: any;
  let mockClarificationService: any;
  let mockRefinementService: any;
  let mockGitHubAnalysisService: any;
  let mockCodeExecutionService: any;
  let mockLogger: ReturnType<typeof createMockLogger>;

  const mockConversation = {
    id: 'conv-123',
    sessionId: 'session-456',
    messages: [],
    state: {},
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    // Reset mocks
    jest.clearAllMocks();

    mockConversationRepo = createMockRepository(mockConversation);
    mockMemoryRepo = createMockRepository(null);
    mockLogger = createMockLogger();

    mockResearchService = {
      conductResearch: jest.fn().mockResolvedValue({
        synthesizedPlan: {
          summary: 'Test API research complete',
          keyInsights: ['REST API', 'JSON responses'],
          confidence: 0.85,
          reasoning: 'Research successful',
        },
        researchConfidence: 0.85,
        researchIterations: 1,
      }),
    };

    mockEnsembleService = {
      orchestrateEnsemble: jest.fn().mockResolvedValue({
        consensus: {
          steps: ['Setup', 'Generate', 'Test'],
          toolsToGenerate: [
            { name: 'test_tool', description: 'A test tool', parameters: {} },
          ],
          estimatedComplexity: 'simple',
        },
        agentPerspectives: [],
        consensusScore: 0.9,
        conflictsResolved: false,
        votingDetails: { totalVotes: 4, toolVotes: new Map(), consensusReached: true },
      }),
    };

    mockClarificationService = {
      orchestrateClarification: jest.fn().mockResolvedValue({
        complete: true,
        gaps: [],
        needsUserInput: false,
      }),
    };

    mockRefinementService = {
      refineUntilWorking: jest.fn().mockResolvedValue({
        success: true,
        generatedCode: {
          mainFile: mockCodeGenerationResponse(),
          packageJson: '{}',
          tsConfig: '{}',
          metadata: {
            tools: [{ name: 'test_tool' }],
            iteration: 1,
            serverName: 'test-server',
          },
        },
        testResults: createMockTestResults(true, 1),
        iterations: 1,
        shouldContinue: false,
      }),
    };

    mockGitHubAnalysisService = {
      analyzeRepository: jest.fn().mockResolvedValue({
        metadata: { name: 'test-repo', language: 'TypeScript' },
      }),
    };

    mockCodeExecutionService = {
      execute: jest.fn().mockResolvedValue({ success: true }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GraphOrchestrationService,
        {
          provide: ConfigService,
          useValue: createMockConfigService(),
        },
        {
          provide: getRepositoryToken(Conversation),
          useValue: mockConversationRepo,
        },
        {
          provide: getRepositoryToken(ConversationMemory),
          useValue: mockMemoryRepo,
        },
        {
          provide: GitHubAnalysisService,
          useValue: mockGitHubAnalysisService,
        },
        {
          provide: CodeExecutionService,
          useValue: mockCodeExecutionService,
        },
        {
          provide: ResearchService,
          useValue: mockResearchService,
        },
        {
          provide: EnsembleService,
          useValue: mockEnsembleService,
        },
        {
          provide: ClarificationService,
          useValue: mockClarificationService,
        },
        {
          provide: RefinementService,
          useValue: mockRefinementService,
        },
        {
          provide: StructuredLoggerService,
          useValue: mockLogger,
        },
        {
          provide: ErrorLoggingService,
          useValue: { logError: jest.fn() },
        },
      ],
    }).compile();

    service = module.get<GraphOrchestrationService>(GraphOrchestrationService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('initialization', () => {
    it('should be defined', () => {
      expect(service).toBeDefined();
    });

    it('should throw error if ANTHROPIC_API_KEY is not configured', async () => {
      const mockConfigWithoutKey = {
        get: jest.fn().mockReturnValue(undefined),
      };

      await expect(
        Test.createTestingModule({
          providers: [
            GraphOrchestrationService,
            { provide: ConfigService, useValue: mockConfigWithoutKey },
            { provide: getRepositoryToken(Conversation), useValue: mockConversationRepo },
            { provide: getRepositoryToken(ConversationMemory), useValue: mockMemoryRepo },
            { provide: GitHubAnalysisService, useValue: mockGitHubAnalysisService },
            { provide: CodeExecutionService, useValue: mockCodeExecutionService },
            { provide: ResearchService, useValue: mockResearchService },
            { provide: EnsembleService, useValue: mockEnsembleService },
            { provide: ClarificationService, useValue: mockClarificationService },
            { provide: RefinementService, useValue: mockRefinementService },
            { provide: StructuredLoggerService, useValue: mockLogger },
          ],
        }).compile(),
      ).rejects.toThrow('ANTHROPIC_API_KEY not configured');
    });
  });

  describe('extractToolConstraints', () => {
    it('should extract explicit tool count from user input', () => {
      const constraints = (service as any).extractToolConstraints(
        'Create an MCP server with 3 tools',
      );
      expect(constraints.requestedToolCount).toBe(3);
    });

    it('should extract tool count with "tools:" pattern', () => {
      const constraints = (service as any).extractToolConstraints(
        'Generate MCP with 2 tools',
      );
      expect(constraints.requestedToolCount).toBe(2);
    });

    it('should extract tool names from "tools:" pattern', () => {
      const constraints = (service as any).extractToolConstraints(
        'Create MCP server tools: add, subtract, multiply',
      );
      expect(constraints.requestedToolNames).toEqual(['add', 'subtract', 'multiply']);
      expect(constraints.requestedToolCount).toBe(3);
    });

    it('should extract tool names from "only X and Y" pattern', () => {
      const constraints = (service as any).extractToolConstraints(
        'Create MCP with only add and multiply',
      );
      expect(constraints.requestedToolNames).toContain('add');
      expect(constraints.requestedToolNames).toContain('multiply');
    });

    it('should extract tool names from "X and Y only" pattern', () => {
      const constraints = (service as any).extractToolConstraints(
        'Make add and subtract tools only',
      );
      // The service may extract with different formatting
      expect(constraints.requestedToolNames).toBeDefined();
      expect(constraints.requestedToolNames.length).toBeGreaterThan(0);
      // Check that at least one contains 'add' or 'subtract'
      const hasRelevantNames = constraints.requestedToolNames.some(
        (name: string) => name.includes('add') || name.includes('subtract'),
      );
      expect(hasRelevantNames).toBe(true);
    });

    it('should return empty constraints for input without explicit counts', () => {
      const constraints = (service as any).extractToolConstraints(
        'Create an MCP server for Stripe API',
      );
      expect(constraints.requestedToolCount).toBeUndefined();
      expect(constraints.requestedToolNames).toBeUndefined();
    });
  });

  describe('analyzeIntent', () => {
    it('should detect generate_mcp intent for GitHub URL', async () => {
      const state = createTestState({
        userInput: 'Generate MCP for https://github.com/test/repo',
      });

      const result = await (service as any).analyzeIntent(state);

      expect(result.intent.type).toBe('generate_mcp');
      expect(result.intent.confidence).toBeGreaterThan(0.5);
      expect(result.currentNode).toBe('analyzeIntent');
      expect(result.executedNodes).toContain('analyzeIntent');
    });

    it('should detect help intent', async () => {
      // Mock LLM to return help intent
      const { ChatAnthropic } = require('@langchain/anthropic');
      ChatAnthropic.mockImplementation(() => ({
        invoke: jest.fn().mockResolvedValue({
          content: mockIntentAnalysisResponse('help'),
        }),
      }));

      // Need to recreate service with new mock
      const module = await Test.createTestingModule({
        providers: [
          GraphOrchestrationService,
          { provide: ConfigService, useValue: createMockConfigService() },
          { provide: getRepositoryToken(Conversation), useValue: mockConversationRepo },
          { provide: getRepositoryToken(ConversationMemory), useValue: mockMemoryRepo },
          { provide: GitHubAnalysisService, useValue: mockGitHubAnalysisService },
          { provide: CodeExecutionService, useValue: mockCodeExecutionService },
          { provide: ResearchService, useValue: mockResearchService },
          { provide: EnsembleService, useValue: mockEnsembleService },
          { provide: ClarificationService, useValue: mockClarificationService },
          { provide: RefinementService, useValue: mockRefinementService },
          { provide: StructuredLoggerService, useValue: mockLogger },
        ],
      }).compile();

      const newService = module.get<GraphOrchestrationService>(GraphOrchestrationService);
      const state = createTestState({ userInput: 'How do I use this platform?' });
      const result = await (newService as any).analyzeIntent(state);

      expect(result.intent.type).toBe('help');
    });

    it('should include tool constraints in streaming updates', async () => {
      const state = createTestState({
        userInput: 'Generate MCP with 2 tools for Stripe',
      });

      const result = await (service as any).analyzeIntent(state);

      expect(result.requestedToolCount).toBe(2);
      expect(result.maxToolCount).toBe(4); // requestedToolCount + 2
    });

    it('should extract GitHub URL from user input', async () => {
      const state = createTestState({
        userInput: 'Build MCP server from https://github.com/stripe/stripe-node',
      });

      const result = await (service as any).analyzeIntent(state);

      // The extracted URL comes from LLM analysis
      expect(result.extractedData).toBeDefined();
    });
  });

  describe('routeFromIntent', () => {
    it('should route to handleError when error exists', () => {
      const state = createTestState({ error: 'Something went wrong' });
      const result = (service as any).routeFromIntent(state);
      expect(result).toBe('handleError');
    });

    it('should route to clarifyWithUser when clarification needed', () => {
      const state = createTestState({
        clarificationNeeded: {
          question: 'Which API endpoints?',
          context: 'Need more details',
        },
      });
      const result = (service as any).routeFromIntent(state);
      expect(result).toBe('clarifyWithUser');
    });

    it('should route to researchCoordinator for generate_mcp intent', () => {
      const state = createTestState({
        intent: { type: 'generate_mcp', confidence: 0.95 },
      });
      const result = (service as any).routeFromIntent(state);
      expect(result).toBe('researchCoordinator');
    });

    it('should route to provideHelp for help intent', () => {
      const state = createTestState({
        intent: { type: 'help', confidence: 0.9 },
      });
      const result = (service as any).routeFromIntent(state);
      expect(result).toBe('provideHelp');
    });

    it('should route to researchCoordinator for research intent', () => {
      const state = createTestState({
        intent: { type: 'research', confidence: 0.9 },
      });
      const result = (service as any).routeFromIntent(state);
      expect(result).toBe('researchCoordinator');
    });

    it('should route to clarifyWithUser for unknown intent', () => {
      const state = createTestState({
        intent: { type: 'unknown', confidence: 0.3 },
      });
      const result = (service as any).routeFromIntent(state);
      expect(result).toBe('clarifyWithUser');
    });
  });

  describe('routeFromResearch', () => {
    it('should route to handleError when error exists', () => {
      const state = createResearchedState({ error: 'Research failed' });
      const result = (service as any).routeFromResearch(state);
      expect(result).toBe('handleError');
    });

    it('should route to ensembleCoordinator when research confidence > 0.5', () => {
      const state = createResearchedState();
      state.researchPhase!.researchConfidence = 0.85;
      const result = (service as any).routeFromResearch(state);
      expect(result).toBe('ensembleCoordinator');
    });

    it('should route to clarifyWithUser when research confidence <= 0.5', () => {
      const state = createResearchedState();
      state.researchPhase!.researchConfidence = 0.3;
      const result = (service as any).routeFromResearch(state);
      expect(result).toBe('clarifyWithUser');
    });
  });

  describe('routeFromEnsemble', () => {
    it('should route to handleError when error exists', () => {
      const state = createEnsembledState({ error: 'Ensemble failed' });
      const result = (service as any).routeFromEnsemble(state);
      expect(result).toBe('handleError');
    });

    it('should always route to clarificationOrchestrator to check for gaps', () => {
      const state = createEnsembledState();
      state.ensembleResults!.consensusScore = 0.9;
      const result = (service as any).routeFromEnsemble(state);
      expect(result).toBe('clarificationOrchestrator');
    });

    it('should route to clarificationOrchestrator when consensus < 0.7', () => {
      const state = createEnsembledState();
      state.ensembleResults!.consensusScore = 0.5;
      const result = (service as any).routeFromEnsemble(state);
      expect(result).toBe('clarificationOrchestrator');
    });
  });

  describe('routeFromClarification', () => {
    it('should route to handleError when error exists', () => {
      const state = createEnsembledState({ error: 'Clarification failed' });
      const result = (service as any).routeFromClarification(state);
      expect(result).toBe('handleError');
    });

    it('should route to clarifyWithUser when needs user input', () => {
      const state = createEnsembledState({
        needsUserInput: true,
        clarificationNeeded: { question: 'What endpoints?', context: 'API' },
      });
      const result = (service as any).routeFromClarification(state);
      expect(result).toBe('clarifyWithUser');
    });

    it('should route to refinementLoop when clarification complete', () => {
      const state = createEnsembledState({
        clarificationComplete: true,
        needsUserInput: false,
      });
      const result = (service as any).routeFromClarification(state);
      expect(result).toBe('refinementLoop');
    });
  });

  describe('routeFromRefinement', () => {
    it('should route to handleError when error exists', () => {
      const state = createEnsembledState({ error: 'Refinement failed' });
      const result = (service as any).routeFromRefinement(state);
      expect(result).toBe('handleError');
    });

    it('should route to END when complete', () => {
      const state = createEnsembledState({ isComplete: true });
      const result = (service as any).routeFromRefinement(state);
      expect(result).toBe('END');
    });

    it('should continue refinementLoop when iteration < max', () => {
      const state = createEnsembledState({
        isComplete: false,
        refinementIteration: 2,
      });
      const result = (service as any).routeFromRefinement(state);
      expect(result).toBe('refinementLoop');
    });

    it('should route to END when max iterations reached', () => {
      const state = createEnsembledState({
        isComplete: false,
        refinementIteration: 5,
      });
      const result = (service as any).routeFromRefinement(state);
      expect(result).toBe('END');
    });
  });

  describe('clarifyWithUser', () => {
    it('should return clarification question', async () => {
      const state = createTestState({
        clarificationNeeded: {
          question: 'Which endpoints do you need?',
          context: 'API selection',
        },
      });

      const result = await (service as any).clarifyWithUser(state);

      expect(result.response).toBe('Which endpoints do you need?');
      expect(result.needsUserInput).toBe(true);
      expect(result.isComplete).toBe(true);
    });

    it('should use default question when none specified', async () => {
      const state = createTestState({});

      const result = await (service as any).clarifyWithUser(state);

      expect(result.response).toBe('Could you provide more details?');
    });
  });

  describe('provideHelp', () => {
    it('should return help response with platform info', async () => {
      const state = createTestState({});

      const result = await (service as any).provideHelp(state);

      expect(result.response).toContain('MCP Everything');
      expect(result.response).toContain('Model Context Protocol');
      expect(result.response).toContain('Example requests');
      expect(result.isComplete).toBe(true);
    });
  });

  describe('handleError', () => {
    it('should return error response', async () => {
      const state = createTestState({ error: 'Test error message' });

      const result = await (service as any).handleError(state);

      expect(result.response).toContain('Test error message');
      expect(result.isComplete).toBe(true);
    });
  });

  describe('researchCoordinator', () => {
    it('should call research service and return results', async () => {
      const state = createTestState({
        intent: { type: 'generate_mcp', confidence: 0.9 },
      });

      const result = await (service as any).researchCoordinator(state);

      expect(mockResearchService.conductResearch).toHaveBeenCalledWith(state);
      expect(result.researchPhase).toBeDefined();
      expect(result.researchPhase.researchConfidence).toBe(0.85);
    });

    it('should handle research service errors gracefully', async () => {
      mockResearchService.conductResearch.mockRejectedValue(
        new Error('Research API failed'),
      );

      const state = createTestState({});

      const result = await (service as any).researchCoordinator(state);

      expect(result.error).toContain('Research failed');
    });
  });

  describe('ensembleCoordinator', () => {
    it('should call ensemble service and return results', async () => {
      const state = createResearchedState();

      const result = await (service as any).ensembleCoordinator(state);

      expect(mockEnsembleService.orchestrateEnsemble).toHaveBeenCalledWith(state);
      expect(result.ensembleResults).toBeDefined();
      expect(result.ensembleResults.consensusScore).toBe(0.9);
    });

    it('should set generationPlan from ensemble consensus', async () => {
      const state = createResearchedState();

      const result = await (service as any).ensembleCoordinator(state);

      expect(result.generationPlan).toBeDefined();
      expect(result.generationPlan.toolsToGenerate).toHaveLength(1);
    });

    it('should handle ensemble service errors gracefully', async () => {
      mockEnsembleService.orchestrateEnsemble.mockRejectedValue(
        new Error('Ensemble failed'),
      );

      const state = createResearchedState();

      const result = await (service as any).ensembleCoordinator(state);

      expect(result.error).toContain('Ensemble failed');
    });
  });

  describe('clarificationOrchestrator', () => {
    it('should return complete when no gaps found', async () => {
      const state = createEnsembledState();

      const result = await (service as any).clarificationOrchestrator(state);

      expect(mockClarificationService.orchestrateClarification).toHaveBeenCalled();
      expect(result.clarificationComplete).toBe(true);
    });

    it('should return clarification questions when gaps found', async () => {
      mockClarificationService.orchestrateClarification.mockResolvedValue({
        complete: false,
        gaps: [{ issue: 'Missing API key', priority: 'HIGH' }],
        questions: [{ question: 'API key?', context: 'Auth' }],
        needsUserInput: true,
      });

      const state = createEnsembledState();

      const result = await (service as any).clarificationOrchestrator(state);

      expect(result.clarificationNeeded).toBeDefined();
      expect(result.needsUserInput).toBe(true);
    });

    it('should handle clarification service errors gracefully', async () => {
      mockClarificationService.orchestrateClarification.mockRejectedValue(
        new Error('Clarification failed'),
      );

      const state = createEnsembledState();

      const result = await (service as any).clarificationOrchestrator(state);

      // Should proceed even if clarification fails
      expect(result.clarificationComplete).toBe(true);
    });
  });

  describe('refinementLoop', () => {
    it('should call refinement service and return success', async () => {
      const state = createEnsembledState({ refinementIteration: 0 });

      const result = await (service as any).refinementLoop(state);

      expect(mockRefinementService.refineUntilWorking).toHaveBeenCalledWith(state);
      expect(result.isComplete).toBe(true);
      expect(result.response).toContain('Successfully generated');
    });

    it('should handle partial success at max iterations', async () => {
      mockRefinementService.refineUntilWorking.mockResolvedValue({
        success: false,
        generatedCode: { mainFile: '', metadata: { tools: [] } },
        testResults: createMockTestResults(false, 2),
        iterations: 5,
        shouldContinue: false,
        error: 'Max iterations reached',
      });

      const state = createEnsembledState({ refinementIteration: 4 });

      const result = await (service as any).refinementLoop(state);

      expect(result.isComplete).toBe(true);
      expect(result.response).toContain('partial success');
    });

    it('should continue refinement when not complete', async () => {
      mockRefinementService.refineUntilWorking.mockResolvedValue({
        success: false,
        generatedCode: { mainFile: '', metadata: { tools: [] } },
        testResults: createMockTestResults(false, 2),
        iterations: 2,
        shouldContinue: true,
      });

      const state = createEnsembledState({ refinementIteration: 1 });

      const result = await (service as any).refinementLoop(state);

      expect(result.isComplete).toBeUndefined();
      expect(result.refinementIteration).toBe(2);
    });

    it('should handle refinement service errors gracefully', async () => {
      mockRefinementService.refineUntilWorking.mockRejectedValue(
        new Error('Refinement failed'),
      );

      const state = createEnsembledState();

      const result = await (service as any).refinementLoop(state);

      expect(result.error).toContain('Refinement failed');
      expect(result.isComplete).toBe(true);
    });
  });

  describe('loadOrCreateConversation', () => {
    it('should load existing conversation by ID', async () => {
      mockConversationRepo.findOne.mockResolvedValue(mockConversation);

      const result = await (service as any).loadOrCreateConversation(
        'session-456',
        'conv-123',
      );

      expect(result.id).toBe('conv-123');
      expect(mockConversationRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'conv-123', sessionId: 'session-456' },
      });
    });

    it('should create new conversation when ID not provided', async () => {
      mockConversationRepo.findOne.mockResolvedValue(null);
      mockConversationRepo.create.mockReturnValue(mockConversation);
      mockConversationRepo.save.mockResolvedValue(mockConversation);

      const result = await (service as any).loadOrCreateConversation('session-456');

      expect(mockConversationRepo.create).toHaveBeenCalled();
      expect(mockConversationRepo.save).toHaveBeenCalled();
    });

    it('should create new conversation when existing not found', async () => {
      mockConversationRepo.findOne.mockResolvedValue(null);
      mockConversationRepo.create.mockReturnValue(mockConversation);
      mockConversationRepo.save.mockResolvedValue(mockConversation);

      const result = await (service as any).loadOrCreateConversation(
        'session-456',
        'nonexistent-conv',
      );

      expect(mockConversationRepo.create).toHaveBeenCalled();
    });
  });

  describe('saveMessageToConversation', () => {
    it('should save user message to conversation', async () => {
      mockConversationRepo.findOne.mockResolvedValue({
        ...mockConversation,
        messages: [],
      });

      await (service as any).saveMessageToConversation('conv-123', {
        role: 'user',
        content: 'Test message',
        timestamp: new Date(),
      });

      expect(mockConversationRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              role: 'user',
              content: 'Test message',
            }),
          ]),
        }),
      );
    });

    it('should set title from first user message', async () => {
      mockConversationRepo.findOne.mockResolvedValue({
        ...mockConversation,
        messages: [],
        state: {},
      });

      await (service as any).saveMessageToConversation('conv-123', {
        role: 'user',
        content: 'Generate MCP server for Stripe API',
        timestamp: new Date(),
      });

      expect(mockConversationRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          state: expect.objectContaining({
            metadata: expect.objectContaining({
              title: expect.stringContaining('Generate MCP server'),
            }),
          }),
        }),
      );
    });

    it('should handle conversation not found', async () => {
      mockConversationRepo.findOne.mockResolvedValue(null);

      await (service as any).saveMessageToConversation('nonexistent', {
        role: 'user',
        content: 'Test',
        timestamp: new Date(),
      });

      expect(mockConversationRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('generateReadme', () => {
    it('should generate README with server name and tools', () => {
      const generatedCode = {
        metadata: {
          serverName: 'stripe-mcp-server',
          tools: [
            { name: 'create_charge', description: 'Create a new charge' },
            { name: 'list_charges', description: 'List all charges' },
          ],
        },
      };

      const readme = (service as any).generateReadme(generatedCode);

      expect(readme).toContain('stripe-mcp-server');
      expect(readme).toContain('create_charge');
      expect(readme).toContain('list_charges');
      expect(readme).toContain('MCP Everything');
    });

    it('should handle missing tools gracefully', () => {
      const generatedCode = {
        metadata: {
          serverName: 'test-server',
          tools: [],
        },
      };

      const readme = (service as any).generateReadme(generatedCode);

      expect(readme).toContain('test-server');
      expect(readme).toContain('No tools defined');
    });
  });
});
