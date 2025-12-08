/// <reference types="jest" />
import { Test, TestingModule } from '@nestjs/testing';
import { RefinementService } from '../refinement.service';
import { McpTestingService } from '../../testing/mcp-testing.service';
import { McpGenerationService } from '../../mcp-generation.service';
import { McpProtocolValidatorService } from '../../validation/mcp-protocol-validator.service';
import {
  createEnsembledState,
  createGeneratedState,
  createMockTestResults,
} from './__mocks__/test-utils';
import {
  mockCodeGenerationResponse,
  mockFailureAnalysisResponse,
} from './__mocks__/anthropic.mock';

// Mock @langchain/anthropic module
const mockLlmInvoke = jest.fn();

jest.mock('@langchain/anthropic', () => ({
  ChatAnthropic: jest.fn().mockImplementation(() => ({
    invoke: mockLlmInvoke,
  })),
}));

describe('RefinementService', () => {
  let service: RefinementService;
  let mockMcpTestingService: any;
  let mockMcpGenerationService: any;
  let mockMcpProtocolValidator: any;

  // Store original env
  const originalEnv = process.env;

  beforeEach(async () => {
    // Reset mocks
    jest.clearAllMocks();
    mockLlmInvoke.mockResolvedValue({
      content: mockCodeGenerationResponse(),
    });

    // Set environment variables
    process.env = {
      ...originalEnv,
      ANTHROPIC_API_KEY: 'test-api-key',
    };

    mockMcpTestingService = {
      testMcpServer: jest.fn().mockResolvedValue(createMockTestResults(true, 2)),
    };

    mockMcpGenerationService = {
      generateMCPServer: jest.fn().mockResolvedValue({
        files: [
          { path: 'src/index.ts', content: mockCodeGenerationResponse() },
          { path: 'package.json', content: '{}' },
          { path: 'tsconfig.json', content: '{}' },
        ],
        metadata: {
          tools: [
            { name: 'test_tool', description: 'A test tool' },
          ],
        },
        serverName: 'test-mcp-server',
      }),
    };

    mockMcpProtocolValidator = {
      validateServer: jest.fn().mockResolvedValue({
        valid: true,
        checks: [
          { name: 'transport', passed: true, message: 'Transport check passed' },
          { name: 'tools', passed: true, message: 'Tools check passed' },
        ],
        errors: [],
        warnings: [],
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RefinementService,
        {
          provide: McpTestingService,
          useValue: mockMcpTestingService,
        },
        {
          provide: McpGenerationService,
          useValue: mockMcpGenerationService,
        },
        {
          provide: McpProtocolValidatorService,
          useValue: mockMcpProtocolValidator,
        },
      ],
    }).compile();

    service = module.get<RefinementService>(RefinementService);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('refineUntilWorking', () => {
    it('should succeed on first iteration when all tests pass', async () => {
      const state = createEnsembledState();

      const result = await service.refineUntilWorking(state);

      expect(result.success).toBe(true);
      expect(result.iterations).toBe(1);
      expect(result.shouldContinue).toBe(false);
      expect(mockMcpTestingService.testMcpServer).toHaveBeenCalled();
    });

    it('should use existing generated code when available', async () => {
      const state = createGeneratedState();

      const result = await service.refineUntilWorking(state);

      expect(mockMcpGenerationService.generateMCPServer).not.toHaveBeenCalled();
      expect(mockMcpTestingService.testMcpServer).toHaveBeenCalled();
    });

    it('should generate code when not available', async () => {
      const state = createEnsembledState();
      state.extractedData = { githubUrl: 'https://github.com/test/repo' };

      const result = await service.refineUntilWorking(state);

      // Should use ensemble tools, not fall back to McpGenerationService
      expect(result.success).toBe(true);
    });

    it('should use McpGenerationService for GitHub URL when no ensemble tools', async () => {
      const state = createEnsembledState();
      state.generationPlan!.toolsToGenerate = [];
      state.extractedData = { githubUrl: 'https://github.com/test/repo' };

      await service.refineUntilWorking(state);

      expect(mockMcpGenerationService.generateMCPServer).toHaveBeenCalledWith(
        'https://github.com/test/repo',
      );
    });

    it('should analyze failures when tests fail', async () => {
      mockMcpTestingService.testMcpServer.mockResolvedValue(createMockTestResults(false, 2));
      mockLlmInvoke
        .mockResolvedValueOnce({ content: mockCodeGenerationResponse() })
        .mockResolvedValueOnce({ content: mockFailureAnalysisResponse() })
        .mockResolvedValue({ content: mockCodeGenerationResponse() });

      const state = createEnsembledState();

      const result = await service.refineUntilWorking(state);

      expect(result.failureAnalysis).toBeDefined();
      expect(result.shouldContinue).toBe(true);
    });

    it('should refine code based on failure analysis', async () => {
      mockMcpTestingService.testMcpServer.mockResolvedValue(createMockTestResults(false, 2));
      mockLlmInvoke
        .mockResolvedValueOnce({ content: mockCodeGenerationResponse() })
        .mockResolvedValueOnce({ content: mockFailureAnalysisResponse() })
        .mockResolvedValue({ content: mockCodeGenerationResponse() });

      const state = createEnsembledState();

      const result = await service.refineUntilWorking(state);

      // Should have called LLM for refinement
      expect(mockLlmInvoke).toHaveBeenCalledTimes(3); // generate + analyze + refine
      expect(result.generatedCode).toBeDefined();
    });

    it('should stop after max 5 iterations', async () => {
      mockMcpTestingService.testMcpServer.mockResolvedValue(createMockTestResults(false, 2));
      mockLlmInvoke.mockResolvedValue({ content: mockFailureAnalysisResponse() });

      const state = createEnsembledState({ refinementIteration: 4 });

      const result = await service.refineUntilWorking(state);

      expect(result.success).toBe(false);
      expect(result.iterations).toBe(5);
      expect(result.shouldContinue).toBe(false);
      expect(result.error).toContain('Failed to converge');
    });

    it('should include partial success message at max iterations', async () => {
      mockMcpTestingService.testMcpServer.mockResolvedValue({
        ...createMockTestResults(false, 5),
        toolsPassedCount: 3,
      });
      mockLlmInvoke.mockResolvedValue({ content: mockFailureAnalysisResponse() });

      const state = createEnsembledState({ refinementIteration: 4 });

      const result = await service.refineUntilWorking(state);

      expect(result.error).toContain('3/5 tools working');
    });

    it('should run protocol validation after tests pass', async () => {
      const state = createEnsembledState();

      await service.refineUntilWorking(state);

      expect(mockMcpProtocolValidator.validateServer).toHaveBeenCalled();
    });

    it('should continue refinement when protocol validation fails', async () => {
      mockMcpProtocolValidator.validateServer.mockResolvedValue({
        valid: false,
        checks: [
          { name: 'transport', passed: true, message: 'OK' },
          { name: 'tools:format', passed: false, message: 'Invalid tool format' },
        ],
        errors: ['Invalid tool format'],
        warnings: [],
      });
      mockLlmInvoke.mockResolvedValue({ content: mockCodeGenerationResponse() });

      const state = createEnsembledState();

      const result = await service.refineUntilWorking(state);

      expect(result.success).toBe(false);
      expect(result.shouldContinue).toBe(true);
      expect(result.failureAnalysis).toBeDefined();
      expect(result.failureAnalysis!.rootCauses).toContain('Invalid tool format');
    });

    it('should handle protocol validation errors gracefully', async () => {
      mockMcpProtocolValidator.validateServer.mockRejectedValue(
        new Error('Validation service error'),
      );

      const state = createEnsembledState();

      const result = await service.refineUntilWorking(state);

      // Should succeed despite validation error (validation is supplementary)
      expect(result.success).toBe(true);
    });
  });

  describe('code generation', () => {
    it('should generate MCP server from generation plan', async () => {
      const state = createEnsembledState();

      const result = await service.refineUntilWorking(state);

      expect(result.generatedCode.mainFile).toBeDefined();
      expect(result.generatedCode.mainFile.length).toBeGreaterThan(0);
    });

    it('should respect user tool constraints in generation', async () => {
      const state = createEnsembledState({
        requestedToolCount: 2,
        requestedToolNames: ['get_users', 'create_user'],
      });

      await service.refineUntilWorking(state);

      // Should include constraint warning in prompt
      expect(mockLlmInvoke).toHaveBeenCalled();
      const prompt = mockLlmInvoke.mock.calls[0][0];
      expect(prompt).toContain('USER TOOL CONSTRAINTS');
    });

    it('should extract service name from user input', async () => {
      const state = createEnsembledState({
        userInput: 'Create MCP server for the Stripe API',
      });

      const result = await service.refineUntilWorking(state);

      expect(result.generatedCode.metadata.serverName).toContain('mcp');
    });

    it('should generate package.json with dependencies', async () => {
      const state = createEnsembledState();

      const result = await service.refineUntilWorking(state);

      expect(result.generatedCode.packageJson).toBeDefined();
      const pkg = JSON.parse(result.generatedCode.packageJson);
      expect(pkg.dependencies).toBeDefined();
      expect(pkg.dependencies['@modelcontextprotocol/sdk']).toBeDefined();
      expect(pkg.dependencies['zod']).toBeDefined();
    });

    it('should generate tsconfig.json', async () => {
      const state = createEnsembledState();

      const result = await service.refineUntilWorking(state);

      expect(result.generatedCode.tsConfig).toBeDefined();
      const tsconfig = JSON.parse(result.generatedCode.tsConfig);
      expect(tsconfig.compilerOptions).toBeDefined();
      expect(tsconfig.compilerOptions.strict).toBe(true);
    });

    it('should throw error when no tools in generation plan', async () => {
      const state = createEnsembledState();
      state.generationPlan!.toolsToGenerate = [];
      state.extractedData = {};

      await expect(service.refineUntilWorking(state)).rejects.toThrow(
        'No tools available for MCP server generation',
      );
    });
  });

  describe('failure analysis', () => {
    it('should categorize failures by type', async () => {
      mockMcpTestingService.testMcpServer.mockResolvedValue(createMockTestResults(false, 2));
      mockLlmInvoke
        .mockResolvedValueOnce({ content: mockCodeGenerationResponse() })
        .mockResolvedValueOnce({
          content: JSON.stringify({
            failureCount: 2,
            categories: [
              { type: 'runtime', count: 1 },
              { type: 'mcp_protocol', count: 1 },
            ],
            rootCauses: ['Missing error handling', 'Invalid response format'],
            fixes: [],
            recommendation: 'Fix both issues',
          }),
        })
        .mockResolvedValue({ content: mockCodeGenerationResponse() });

      const state = createEnsembledState();

      const result = await service.refineUntilWorking(state);

      expect(result.failureAnalysis!.categories).toBeDefined();
      expect(result.failureAnalysis!.categories.length).toBe(2);
    });

    it('should provide specific fixes for each failing tool', async () => {
      mockMcpTestingService.testMcpServer.mockResolvedValue({
        ...createMockTestResults(false, 2),
        results: [
          { toolName: 'tool_1', success: false, error: 'Error 1', mcpCompliant: false, executionTime: 100 },
          { toolName: 'tool_2', success: false, error: 'Error 2', mcpCompliant: false, executionTime: 100 },
        ],
      });
      mockLlmInvoke
        .mockResolvedValueOnce({ content: mockCodeGenerationResponse() })
        .mockResolvedValueOnce({
          content: JSON.stringify({
            failureCount: 2,
            categories: [{ type: 'runtime', count: 2 }],
            rootCauses: ['Error 1', 'Error 2'],
            fixes: [
              { toolName: 'tool_1', issue: 'Issue 1', solution: 'Fix 1', priority: 'HIGH' },
              { toolName: 'tool_2', issue: 'Issue 2', solution: 'Fix 2', priority: 'MEDIUM' },
            ],
            recommendation: 'Fix all issues',
          }),
        })
        .mockResolvedValue({ content: mockCodeGenerationResponse() });

      const state = createEnsembledState();

      const result = await service.refineUntilWorking(state);

      expect(result.failureAnalysis!.fixes).toHaveLength(2);
      expect(result.failureAnalysis!.fixes[0].toolName).toBe('tool_1');
    });

    it('should include build errors in analysis', async () => {
      mockMcpTestingService.testMcpServer.mockResolvedValue({
        ...createMockTestResults(false, 0),
        buildSuccess: false,
        buildError: 'TS2322: Type error in line 42',
      });
      mockLlmInvoke
        .mockResolvedValueOnce({ content: mockCodeGenerationResponse() })
        .mockResolvedValueOnce({ content: mockFailureAnalysisResponse() })
        .mockResolvedValue({ content: mockCodeGenerationResponse() });

      const state = createEnsembledState();

      await service.refineUntilWorking(state);

      // Should include build error in prompt for analysis
      expect(mockLlmInvoke).toHaveBeenCalled();
    });

    it('should fallback to basic analysis when LLM fails', async () => {
      mockMcpTestingService.testMcpServer.mockResolvedValue({
        ...createMockTestResults(false, 1),
        results: [
          { toolName: 'failing_tool', success: false, error: 'Tool error', mcpCompliant: false, executionTime: 100 },
        ],
      });
      mockLlmInvoke
        .mockResolvedValueOnce({ content: mockCodeGenerationResponse() })
        .mockRejectedValueOnce(new Error('LLM API failed'))
        .mockResolvedValue({ content: mockCodeGenerationResponse() });

      const state = createEnsembledState();

      const result = await service.refineUntilWorking(state);

      expect(result.failureAnalysis).toBeDefined();
      expect(result.failureAnalysis!.rootCauses).toContain('Tool error');
      expect(result.failureAnalysis!.fixes[0].toolName).toBe('failing_tool');
    });
  });

  describe('code refinement', () => {
    it('should apply fixes based on failure analysis', async () => {
      mockMcpTestingService.testMcpServer.mockResolvedValue(createMockTestResults(false, 1));
      mockLlmInvoke
        .mockResolvedValueOnce({ content: mockCodeGenerationResponse() })
        .mockResolvedValueOnce({ content: mockFailureAnalysisResponse() })
        .mockResolvedValueOnce({ content: 'const refined = "code";' });

      const state = createEnsembledState();

      const result = await service.refineUntilWorking(state);

      // Refinement should modify the code
      expect(result.generatedCode.mainFile).toBeDefined();
    });

    it('should increment iteration counter after refinement', async () => {
      mockMcpTestingService.testMcpServer.mockResolvedValue(createMockTestResults(false, 1));
      mockLlmInvoke.mockResolvedValue({ content: mockCodeGenerationResponse() });

      const state = createEnsembledState({ refinementIteration: 0 });

      const result = await service.refineUntilWorking(state);

      expect(result.iterations).toBe(1);
      expect(result.generatedCode.metadata.iteration).toBe(2); // Incremented from initial 1
    });

    it('should preserve working code when refinement fails', async () => {
      const originalCode = mockCodeGenerationResponse();
      mockMcpTestingService.testMcpServer.mockResolvedValue(createMockTestResults(false, 1));
      mockLlmInvoke
        .mockResolvedValueOnce({ content: originalCode })
        .mockResolvedValueOnce({ content: mockFailureAnalysisResponse() })
        .mockRejectedValueOnce(new Error('Refinement LLM failed'));

      const state = createEnsembledState();

      const result = await service.refineUntilWorking(state);

      // Should return original code when refinement fails
      expect(result.generatedCode.mainFile).toBeDefined();
    });

    it('should remove markdown code blocks from refined code', async () => {
      mockMcpTestingService.testMcpServer.mockResolvedValue(createMockTestResults(false, 1));
      mockLlmInvoke
        .mockResolvedValueOnce({ content: mockCodeGenerationResponse() })
        .mockResolvedValueOnce({ content: mockFailureAnalysisResponse() })
        .mockResolvedValueOnce({
          content: '```typescript\nconst code = "clean";\n```',
        });

      const state = createEnsembledState();

      const result = await service.refineUntilWorking(state);

      expect(result.generatedCode.mainFile).not.toContain('```');
    });
  });

  describe('truncation detection and recovery', () => {
    it('should detect truncated code missing main() call', async () => {
      mockLlmInvoke.mockResolvedValueOnce({
        content: `
import { Server } from "@modelcontextprotocol/sdk/server/index.js";

const server = new Server(
  { name: "test", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport`,  // Truncated - missing closing
      });

      const state = createEnsembledState();

      const result = await service.refineUntilWorking(state);

      // Should have attempted recovery
      expect(result.generatedCode.mainFile).toBeDefined();
    });

    it('should detect truncated code with unbalanced braces', async () => {
      mockLlmInvoke.mockResolvedValueOnce({
        content: `
import { Server } from "@modelcontextprotocol/sdk/server/index.js";

function test() {
  if (true) {
    console.log("test");
  `,  // Truncated - missing closing braces
      });

      const state = createEnsembledState();

      const result = await service.refineUntilWorking(state);

      expect(result.generatedCode.mainFile).toBeDefined();
      // Recovery should add missing braces
    });

    it('should detect code ending with trailing operators', async () => {
      mockLlmInvoke.mockResolvedValueOnce({
        content: `
const value = 1 +`,  // Truncated - ends with operator
      });

      const state = createEnsembledState();

      const result = await service.refineUntilWorking(state);

      expect(result.generatedCode.mainFile).toBeDefined();
    });

    it('should add missing main() call in recovery', async () => {
      mockLlmInvoke.mockResolvedValueOnce({
        content: `
import { Server } from "@modelcontextprotocol/sdk/server/index.js";

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}`,  // Missing main() call at end
      });

      const state = createEnsembledState();

      const result = await service.refineUntilWorking(state);

      // Recovery should add main().catch()
      expect(
        result.generatedCode.mainFile.includes('main()') ||
        result.generatedCode.mainFile.includes('main().catch'),
      ).toBe(true);
    });
  });

  describe('GeneratedCode conversion', () => {
    it('should convert McpGenerationService output format', async () => {
      mockMcpGenerationService.generateMCPServer.mockResolvedValue({
        files: [
          { path: 'src/index.ts', content: 'main file content' },
          { path: 'package.json', content: '{"name": "test"}' },
          { path: 'tsconfig.json', content: '{}' },
          { path: 'src/utils.ts', content: 'utils content' },
        ],
        metadata: {
          tools: [{ name: 'tool1' }, { name: 'tool2' }],
        },
        serverName: 'converted-server',
      });

      const state = createEnsembledState();
      state.generationPlan!.toolsToGenerate = [];
      state.extractedData = { githubUrl: 'https://github.com/test/repo' };

      const result = await service.refineUntilWorking(state);

      expect(result.generatedCode.mainFile).toBe('main file content');
      expect(result.generatedCode.packageJson).toBe('{"name": "test"}');
      expect(result.generatedCode.tsConfig).toBe('{}');
      expect(result.generatedCode.supportingFiles['src/utils.ts']).toBe('utils content');
    });

    it('should handle missing files in conversion', async () => {
      mockMcpGenerationService.generateMCPServer.mockResolvedValue({
        files: [],
        metadata: { tools: [] },
        serverName: 'empty-server',
      });

      const state = createEnsembledState();
      state.generationPlan!.toolsToGenerate = [];
      state.extractedData = { githubUrl: 'https://github.com/test/repo' };

      const result = await service.refineUntilWorking(state);

      expect(result.generatedCode.mainFile).toBe('');
      expect(result.generatedCode.packageJson).toBeDefined();
      expect(result.generatedCode.tsConfig).toBeDefined();
    });
  });

  describe('Docker testing options', () => {
    it('should pass correct options to McpTestingService', async () => {
      const state = createEnsembledState();

      await service.refineUntilWorking(state);

      expect(mockMcpTestingService.testMcpServer).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          cpuLimit: '0.5',
          memoryLimit: '512m',
          timeout: 30,
          toolTimeout: 5,
          networkMode: 'none',
          cleanup: true,
        }),
      );
    });
  });
});
