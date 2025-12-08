/**
 * Test Utilities for Orchestration Services
 *
 * Provides helper functions and factory methods for creating
 * test states and mock data.
 */

import { GraphState } from '../../types';

/**
 * Create a minimal test state for graph execution
 */
export function createTestState(overrides: Partial<GraphState> = {}): GraphState {
  return {
    sessionId: 'test-session-123',
    conversationId: 'test-conv-456',
    messages: [],
    userInput: 'Generate MCP server for test API',
    currentNode: 'analyzeIntent',
    executedNodes: [],
    needsUserInput: false,
    isComplete: false,
    streamingUpdates: [],
    ...overrides,
  };
}

/**
 * Create state with research phase data
 */
export function createResearchedState(overrides: Partial<GraphState> = {}): GraphState {
  return createTestState({
    intent: {
      type: 'generate_mcp',
      confidence: 0.95,
      reasoning: 'User wants to generate an MCP server',
    },
    extractedData: {
      githubUrl: 'https://github.com/test/repo',
      repositoryName: 'test-repo',
    },
    researchPhase: {
      webSearchFindings: {
        queries: ['test API documentation'],
        results: [
          {
            url: 'https://docs.test.com/api',
            title: 'Test API Documentation',
            snippet: 'Official API documentation for Test service',
            relevanceScore: 0.9,
          },
        ],
        patterns: ['REST API', 'JSON responses', 'API key auth'],
        bestPractices: [
          'Base URL: https://api.test.com/v1',
          'Authentication: api_key',
          'Use TypeScript for type safety',
        ],
        timestamp: new Date(),
      },
      githubDeepDive: {
        basicInfo: {
          name: 'test-repo',
          description: 'Test repository',
          language: 'TypeScript',
          stars: 1500,
          topics: ['api', 'sdk'],
        },
        codeExamples: [],
        testPatterns: [],
        apiUsagePatterns: [],
        dependencies: { axios: '^1.0.0', zod: '^3.0.0' },
      },
      synthesizedPlan: {
        summary: 'Generate MCP server with 5 tools for Test API',
        keyInsights: ['REST API', 'API key authentication', 'JSON responses'],
        recommendedApproach: 'TypeScript MCP server with axios for HTTP',
        potentialChallenges: ['Rate limiting'],
        confidence: 0.85,
        reasoning: 'Comprehensive research available',
      },
      researchConfidence: 0.85,
      researchIterations: 1,
    },
    ...overrides,
  });
}

/**
 * Create state with ensemble results
 */
export function createEnsembledState(overrides: Partial<GraphState> = {}): GraphState {
  return createResearchedState({
    ensembleResults: {
      agentPerspectives: [
        {
          agentName: 'architect',
          recommendations: {
            tools: [
              {
                name: 'get_users',
                description: 'Get list of users',
                inputSchema: { type: 'object', properties: {} },
                outputFormat: 'JSON array',
                priority: 'high',
                estimatedComplexity: 'simple',
              },
            ],
            reasoning: 'Standard CRUD operations',
            concerns: [],
          },
          confidence: 0.9,
          weight: 1.0,
          timestamp: new Date(),
        },
        {
          agentName: 'mcpSpecialist',
          recommendations: {
            tools: [
              {
                name: 'get_users',
                description: 'Get list of users',
                inputSchema: { type: 'object', properties: {} },
                outputFormat: 'JSON array',
                priority: 'high',
                estimatedComplexity: 'simple',
              },
            ],
            reasoning: 'MCP compliant tools',
            concerns: [],
          },
          confidence: 0.95,
          weight: 1.2,
          timestamp: new Date(),
        },
      ],
      consensusScore: 0.85,
      conflictsResolved: false,
      votingDetails: {
        totalVotes: 2,
        toolVotes: new Map(),
        consensusReached: true,
      },
    },
    generationPlan: {
      steps: ['Setup project', 'Implement tools', 'Test', 'Validate'],
      toolsToGenerate: [
        {
          name: 'get_users',
          description: 'Get list of users',
          parameters: { type: 'object', properties: {} },
        },
        {
          name: 'create_user',
          description: 'Create a new user',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              email: { type: 'string' },
            },
            required: ['name', 'email'],
          },
        },
      ],
      estimatedComplexity: 'moderate',
    },
    ...overrides,
  });
}

/**
 * Create state with generated code
 */
export function createGeneratedState(overrides: Partial<GraphState> = {}): GraphState {
  return createEnsembledState({
    generatedCode: {
      mainFile: `
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new Server(
  { name: "test-mcp-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
`,
      packageJson: JSON.stringify({
        name: 'test-mcp-server',
        version: '1.0.0',
        type: 'module',
        main: 'dist/index.js',
        scripts: {
          build: 'tsc',
          start: 'node dist/index.js',
        },
        dependencies: {
          '@modelcontextprotocol/sdk': '^0.5.0',
          zod: '^3.23.0',
        },
        devDependencies: {
          '@types/node': '^20.0.0',
          typescript: '^5.0.0',
        },
      }),
      tsConfig: JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'Node16',
          moduleResolution: 'Node16',
          outDir: './dist',
          rootDir: './src',
          strict: true,
        },
        include: ['src/**/*'],
      }),
      supportingFiles: {},
      metadata: {
        tools: [
          { name: 'get_users', description: 'Get list of users' },
          { name: 'create_user', description: 'Create a new user' },
        ],
        iteration: 1,
        serverName: 'test-mcp-server',
      },
    },
    refinementIteration: 0,
    ...overrides,
  });
}

/**
 * Create mock MCP test results
 */
export function createMockTestResults(success: boolean = true, toolCount: number = 2) {
  return {
    overallSuccess: success,
    buildSuccess: true,
    toolsFound: toolCount,
    toolsPassedCount: success ? toolCount : 0,
    results: Array.from({ length: toolCount }, (_, i) => ({
      toolName: `tool_${i + 1}`,
      success,
      error: success ? undefined : 'Test execution failed',
      mcpCompliant: success,
      executionTime: 100,
    })),
    buildError: undefined,
    containerLogs: 'Test logs',
  };
}

/**
 * Create mock ConfigService
 */
export function createMockConfigService(overrides: Record<string, any> = {}) {
  const defaultConfig = {
    ANTHROPIC_API_KEY: 'test-api-key',
    GITHUB_TOKEN: 'test-github-token',
    TAVILY_API_KEY: 'test-tavily-key',
    ...overrides,
  };

  return {
    get: jest.fn((key: string) => defaultConfig[key]),
    getOrThrow: jest.fn((key: string) => {
      if (!defaultConfig[key]) {
        throw new Error(`Config key ${key} not found`);
      }
      return defaultConfig[key];
    }),
  };
}

/**
 * Create mock repository for TypeORM
 */
export function createMockRepository<T>(defaultValue: T | null = null) {
  return {
    create: jest.fn().mockImplementation((entity) => entity),
    save: jest.fn().mockImplementation((entity) => Promise.resolve(entity)),
    update: jest.fn().mockResolvedValue({}),
    delete: jest.fn().mockResolvedValue({}),
    find: jest.fn().mockResolvedValue([defaultValue].filter(Boolean)),
    findOne: jest.fn().mockResolvedValue(defaultValue),
    findOneBy: jest.fn().mockResolvedValue(defaultValue),
  };
}

/**
 * Create mock StructuredLoggerService
 */
export function createMockLogger() {
  return {
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    setContext: jest.fn().mockReturnThis(),
  };
}

/**
 * Wait for async operations to complete
 */
export async function flushPromises(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
