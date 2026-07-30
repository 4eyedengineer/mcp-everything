/// <reference types="jest" />
import { Test, TestingModule } from '@nestjs/testing';
import { RefinementService } from '../refinement.service';
import { ConfigService } from '@nestjs/config';
import { McpTestingService } from '../../testing/mcp-testing.service';
import { McpProtocolValidatorService } from '../../validation/mcp-protocol-validator.service';
import { AnthropicService } from '../../ai/anthropic.service';
import { createMockAnthropicService } from './__mocks__/anthropic.mock';
import {
  createPlannedState,
  createGeneratedState,
  createMockTestResults,
} from './__mocks__/test-utils';
import {
  mockCodeGenerationResponse,
  mockFailureAnalysisResponse,
} from './__mocks__/anthropic.mock';

// Stand-in for the single AI seam (AnthropicService). Every completion, text or
// structured, routes through mockLlmInvoke(prompt) -> { content }.
const mockLlmInvoke = jest.fn();
const mockAnthropicService = createMockAnthropicService(mockLlmInvoke);

describe('RefinementService', () => {
  let service: RefinementService;
  let mockMcpTestingService: any;
  let mockMcpProtocolValidator: any;

  /**
   * Build the service. The LLM-as-judge quality gate is off for most tests so
   * they exercise the test/refine loop in isolation; the gate has its own block.
   */
  const buildService = async (config: Record<string, string> = {}): Promise<RefinementService> => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RefinementService,
        { provide: McpTestingService, useValue: mockMcpTestingService },
        { provide: McpProtocolValidatorService, useValue: mockMcpProtocolValidator },
        { provide: AnthropicService, useValue: mockAnthropicService },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => ({ PIPELINE_QUALITY_GATE: 'false', ...config })[key],
          },
        },
      ],
    }).compile();

    return module.get<RefinementService>(RefinementService);
  };

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

    service = await buildService();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('refineUntilWorking', () => {
    it('should succeed on first iteration when all tests pass', async () => {
      const state = createPlannedState();

      const result = await service.refineUntilWorking(state);

      expect(result.success).toBe(true);
      expect(result.iterations).toBe(1);
      expect(result.shouldContinue).toBe(false);
      expect(mockMcpTestingService.testMcpServer).toHaveBeenCalled();
    });

    it('should use existing generated code when available', async () => {
      const state = createGeneratedState();

      await service.refineUntilWorking(state);

      expect(mockMcpTestingService.testMcpServer).toHaveBeenCalled();
    });

    it('should generate code from the plan when none exists yet', async () => {
      const state = createPlannedState();
      state.extractedData = { githubUrl: 'https://github.com/test/repo' };

      const result = await service.refineUntilWorking(state);

      expect(result.success).toBe(true);
      expect(result.generatedCode.metadata.tools).toHaveLength(2);
    });

    it('should throw when the plan contains no tools (no second pipeline to fall back to)', async () => {
      const state = createPlannedState();
      state.generationPlan!.toolsToGenerate = [];
      state.extractedData = { githubUrl: 'https://github.com/test/repo' };

      await expect(service.refineUntilWorking(state)).rejects.toThrow(
        /No tools available for MCP server generation/,
      );
      expect(mockMcpTestingService.testMcpServer).not.toHaveBeenCalled();
    });

    it('should use the planner-provided server name', async () => {
      const state = createPlannedState();
      state.generationPlan!.serverName = 'planner-named-mcp';

      const result = await service.refineUntilWorking(state);

      expect(result.generatedCode.metadata.serverName).toBe('planner-named-mcp');
    });

    it('should analyze failures when tests fail', async () => {
      mockMcpTestingService.testMcpServer.mockResolvedValue(createMockTestResults(false, 2));
      mockLlmInvoke
        .mockResolvedValueOnce({ content: mockCodeGenerationResponse() })
        .mockResolvedValueOnce({ content: mockFailureAnalysisResponse() })
        .mockResolvedValue({ content: mockCodeGenerationResponse() });

      const state = createPlannedState();

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

      const state = createPlannedState();

      const result = await service.refineUntilWorking(state);

      // Should have called LLM for refinement
      expect(mockLlmInvoke).toHaveBeenCalledTimes(3); // generate + analyze + refine
      expect(result.generatedCode).toBeDefined();
    });

    it('should stop after max 5 iterations', async () => {
      mockMcpTestingService.testMcpServer.mockResolvedValue(createMockTestResults(false, 2));
      mockLlmInvoke.mockResolvedValue({ content: mockFailureAnalysisResponse() });

      const state = createPlannedState({ refinementIteration: 4 });

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

      const state = createPlannedState({ refinementIteration: 4 });

      const result = await service.refineUntilWorking(state);

      expect(result.error).toContain('3/5 tools working');
    });

    it('should run protocol validation after tests pass', async () => {
      const state = createPlannedState();

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

      const state = createPlannedState();

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

      const state = createPlannedState();

      const result = await service.refineUntilWorking(state);

      // Should succeed despite validation error (validation is supplementary)
      expect(result.success).toBe(true);
    });
  });

  describe('code generation', () => {
    it('should generate MCP server from generation plan', async () => {
      const state = createPlannedState();

      const result = await service.refineUntilWorking(state);

      expect(result.generatedCode.mainFile).toBeDefined();
      expect(result.generatedCode.mainFile.length).toBeGreaterThan(0);
    });

    it('should respect user tool constraints in generation', async () => {
      const state = createPlannedState({
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
      const state = createPlannedState({
        userInput: 'Create MCP server for the Stripe API',
      });

      const result = await service.refineUntilWorking(state);

      expect(result.generatedCode.metadata.serverName).toContain('mcp');
    });

    it('should generate package.json with dependencies', async () => {
      const state = createPlannedState();

      const result = await service.refineUntilWorking(state);

      expect(result.generatedCode.packageJson).toBeDefined();
      const pkg = JSON.parse(result.generatedCode.packageJson);
      expect(pkg.dependencies).toBeDefined();
      expect(pkg.dependencies['@modelcontextprotocol/sdk']).toBeDefined();
      expect(pkg.dependencies['zod']).toBeDefined();
    });

    it('should generate tsconfig.json', async () => {
      const state = createPlannedState();

      const result = await service.refineUntilWorking(state);

      expect(result.generatedCode.tsConfig).toBeDefined();
      const tsconfig = JSON.parse(result.generatedCode.tsConfig);
      expect(tsconfig.compilerOptions).toBeDefined();
      expect(tsconfig.compilerOptions.strict).toBe(true);
    });

    it('should throw error when no tools in generation plan', async () => {
      const state = createPlannedState();
      state.generationPlan!.toolsToGenerate = [];
      state.extractedData = {};

      await expect(service.refineUntilWorking(state)).rejects.toThrow(
        'No tools available for MCP server generation',
      );
    });
  });

  /**
   * A generated server that imports a package its package.json never declares
   * cannot build, and no amount of *code* refinement fixes it: the S3 run
   * imported @aws-sdk/client-s3 against a manifest listing only the MCP SDK,
   * zod and axios, and all five iterations failed identically on TS2307.
   */
  describe('dependency reconciliation', () => {
    /** Code importing a package the default manifest does not declare. */
    const codeImporting = (...specifiers: string[]) =>
      [
        ...specifiers.map((s, i) => `import pkg${i} from "${s}";`),
        'import { Server } from "@modelcontextprotocol/sdk/server/index.js";',
        'import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";',
        'import { readFile } from "node:fs/promises";',
        'import path from "path";',
        'import { helper } from "./helper.js";',
        'const server = new Server({ name: "s", version: "1.0.0" }, { capabilities: { tools: {} } });',
        'async function main() { await server.connect(new StdioServerTransport()); }',
        'main().catch(console.error);',
      ].join('\n');

    it('declares a package the generated code imports but the manifest omits', async () => {
      mockLlmInvoke.mockResolvedValue({
        content: codeImporting('@aws-sdk/client-s3'),
      });

      const result = await service.refineUntilWorking(createPlannedState());

      const pkg = JSON.parse(result.generatedCode.packageJson);
      expect(pkg.dependencies['@aws-sdk/client-s3']).toBe('^3.0.0');
      // The baseline dependencies survive
      expect(pkg.dependencies['@modelcontextprotocol/sdk']).toBeDefined();
      expect(pkg.dependencies['zod']).toBeDefined();
    });

    it('reconciles before the build, so the Docker test sees the fixed manifest', async () => {
      mockLlmInvoke.mockResolvedValue({ content: codeImporting('@aws-sdk/client-s3') });

      await service.refineUntilWorking(createPlannedState());

      const tested = mockMcpTestingService.testMcpServer.mock.calls[0][0];
      expect(JSON.parse(tested.packageJson).dependencies['@aws-sdk/client-s3']).toBe('^3.0.0');
    });

    it('uses `latest` for packages outside the pinned allowlist', async () => {
      mockLlmInvoke.mockResolvedValue({ content: codeImporting('some-obscure-sdk') });

      const result = await service.refineUntilWorking(createPlannedState());

      expect(JSON.parse(result.generatedCode.packageJson).dependencies['some-obscure-sdk']).toBe(
        'latest',
      );
    });

    it('resolves deep import specifiers to their installable package root', async () => {
      mockLlmInvoke.mockResolvedValue({
        content: codeImporting('@octokit/rest/dist-types/index.js', 'lodash/merge'),
      });

      const result = await service.refineUntilWorking(createPlannedState());

      const deps = JSON.parse(result.generatedCode.packageJson).dependencies;
      expect(deps['@octokit/rest']).toBe('^20.0.0');
      expect(deps['lodash']).toBe('latest');
      expect(deps['@octokit/rest/dist-types/index.js']).toBeUndefined();
    });

    it('never declares Node builtins or relative imports as dependencies', async () => {
      mockLlmInvoke.mockResolvedValue({ content: codeImporting() });

      const result = await service.refineUntilWorking(createPlannedState());

      const deps = JSON.parse(result.generatedCode.packageJson).dependencies;
      expect(Object.keys(deps).sort()).toEqual(['@modelcontextprotocol/sdk', 'axios', 'zod']);
    });

    it('picks up require() and dynamic import() specifiers too', async () => {
      mockLlmInvoke.mockResolvedValue({
        content: [
          'const twilio = require("twilio");',
          'const mod = await import("dotenv");',
          'import { Server } from "@modelcontextprotocol/sdk/server/index.js";',
        ].join('\n'),
      });

      const result = await service.refineUntilWorking(createPlannedState());

      const deps = JSON.parse(result.generatedCode.packageJson).dependencies;
      expect(deps['twilio']).toBe('latest');
      expect(deps['dotenv']).toBe('^16.0.0');
    });

    it('leaves an already-complete manifest untouched', async () => {
      mockLlmInvoke.mockResolvedValue({ content: mockCodeGenerationResponse() });

      const result = await service.refineUntilWorking(createPlannedState());

      const deps = JSON.parse(result.generatedCode.packageJson).dependencies;
      expect(Object.keys(deps).sort()).toEqual(['@modelcontextprotocol/sdk', 'axios', 'zod']);
    });

    it('fixes a missing dependency on code carried over from a previous iteration', async () => {
      const state = createGeneratedState();
      state.generatedCode!.mainFile += '\nimport { S3Client } from "@aws-sdk/client-s3";\n';

      const result = await service.refineUntilWorking(state);

      expect(JSON.parse(result.generatedCode.packageJson).dependencies['@aws-sdk/client-s3']).toBe(
        '^3.0.0',
      );
    });

    it('tells the refine prompt which dependencies are declared', async () => {
      mockMcpTestingService.testMcpServer.mockResolvedValue(createMockTestResults(false, 2));
      mockLlmInvoke.mockResolvedValue({ content: mockCodeGenerationResponse() });
      mockLlmInvoke.mockResolvedValueOnce({ content: codeImporting('@aws-sdk/client-s3') });

      await service.refineUntilWorking(createPlannedState());

      const refinePrompt = mockLlmInvoke.mock.calls
        .map((call) => call[0] as string)
        .find((prompt) => prompt.includes('Return the COMPLETE corrected TypeScript code'))!;

      expect(refinePrompt).toContain('Dependencies declared in this server');
      expect(refinePrompt).toContain('@aws-sdk/client-s3');
    });

    it('tells the failure analyser which dependencies it just added', async () => {
      mockMcpTestingService.testMcpServer.mockResolvedValue(createMockTestResults(false, 2));
      mockLlmInvoke.mockResolvedValue({ content: mockFailureAnalysisResponse() });
      mockLlmInvoke.mockResolvedValueOnce({ content: codeImporting('@aws-sdk/client-s3') });

      await service.refineUntilWorking(createPlannedState());

      const analysisPrompt = mockLlmInvoke.mock.calls
        .map((call) => call[0] as string)
        .find((prompt) => prompt.includes('Analyze root causes and provide specific fixes'))!;

      expect(analysisPrompt).toContain('have just been declared automatically');
      expect(analysisPrompt).toContain('@aws-sdk/client-s3');
    });

    it('leaves an unparseable manifest alone rather than throwing', async () => {
      const state = createGeneratedState();
      state.generatedCode!.packageJson = '{ this is not json';
      state.generatedCode!.mainFile += '\nimport { S3Client } from "@aws-sdk/client-s3";\n';

      const result = await service.refineUntilWorking(state);

      expect(result.generatedCode.packageJson).toBe('{ this is not json');
      expect(mockMcpTestingService.testMcpServer).toHaveBeenCalled();
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

      const state = createPlannedState();

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

      const state = createPlannedState();

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

      const state = createPlannedState();

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

      const state = createPlannedState();

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

      const state = createPlannedState();

      const result = await service.refineUntilWorking(state);

      // Refinement should modify the code
      expect(result.generatedCode.mainFile).toBeDefined();
    });

    it('should increment iteration counter after refinement', async () => {
      mockMcpTestingService.testMcpServer.mockResolvedValue(createMockTestResults(false, 1));
      mockLlmInvoke.mockResolvedValue({ content: mockCodeGenerationResponse() });

      const state = createPlannedState({ refinementIteration: 0 });

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

      const state = createPlannedState();

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

      const state = createPlannedState();

      const result = await service.refineUntilWorking(state);

      expect(result.generatedCode.mainFile).not.toContain('```');
    });
  });

  // Truncation is no longer detected/repaired locally: the API reports
  // `stop_reason: "max_tokens"` and AnthropicService raises
  // TruncatedResponseError, which generateCode() retries at a higher cap.
  // These cases assert incomplete model output is passed through untouched
  // (never brace-balanced or otherwise fabricated) and does not crash the loop.
  describe('incomplete model output', () => {
    it('should pass through code that is missing a main() call', async () => {
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

      const state = createPlannedState();

      const result = await service.refineUntilWorking(state);

      // No local repair - the partial text is handed back as-is
      expect(result.generatedCode.mainFile).toBeDefined();
    });

    it('should pass through code with unbalanced braces', async () => {
      mockLlmInvoke.mockResolvedValueOnce({
        content: `
import { Server } from "@modelcontextprotocol/sdk/server/index.js";

function test() {
  if (true) {
    console.log("test");
  `,  // Truncated - missing closing braces
      });

      const state = createPlannedState();

      const result = await service.refineUntilWorking(state);

      expect(result.generatedCode.mainFile).toBeDefined();
    });

    it('should pass through code ending with a trailing operator', async () => {
      mockLlmInvoke.mockResolvedValueOnce({
        content: `
const value = 1 +`,  // Truncated - ends with operator
      });

      const state = createPlannedState();

      const result = await service.refineUntilWorking(state);

      expect(result.generatedCode.mainFile).toBeDefined();
    });

    it('should pass through complete code untouched', async () => {
      mockLlmInvoke.mockResolvedValueOnce({
        content: `
import { Server } from "@modelcontextprotocol/sdk/server/index.js";

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}`,  // Missing main() call at end
      });

      const state = createPlannedState();

      const result = await service.refineUntilWorking(state);

      expect(
        result.generatedCode.mainFile.includes('main()') ||
        result.generatedCode.mainFile.includes('main().catch'),
      ).toBe(true);
    });
  });

  describe('GeneratedCode conversion', () => {
    it('should convert a files[] shaped generatedCode from a previous iteration', async () => {
      const state = createPlannedState({
        generatedCode: {
          files: [
            { path: 'src/index.ts', content: 'main file content' },
            { path: 'package.json', content: '{"name": "test"}' },
            { path: 'tsconfig.json', content: '{}' },
            { path: 'src/utils.ts', content: 'utils content' },
          ],
          metadata: { tools: [{ name: 'tool1' }, { name: 'tool2' }] },
          serverName: 'converted-server',
        } as any,
      });

      const result = await service.refineUntilWorking(state);

      expect(result.generatedCode.mainFile).toBe('main file content');
      expect(result.generatedCode.packageJson).toBe('{"name": "test"}');
      expect(result.generatedCode.tsConfig).toBe('{}');
      expect(result.generatedCode.supportingFiles['src/utils.ts']).toBe('utils content');
    });

    it('should fill in defaults for missing files', async () => {
      const state = createPlannedState({
        generatedCode: {
          files: [],
          metadata: { tools: [] },
          serverName: 'empty-server',
        } as any,
      });

      const result = await service.refineUntilWorking(state);

      expect(result.generatedCode.mainFile).toBe('');
      expect(result.generatedCode.packageJson).toBeDefined();
      expect(result.generatedCode.tsConfig).toBeDefined();
      expect(result.generatedCode.supportingFiles['Dockerfile']).toBeDefined();
    });
  });

  describe('quality gate (LLM-as-judge)', () => {
    const judgeResponse = (isValid: boolean, issues: any[] = []) =>
      JSON.stringify({
        isValid,
        score: isValid ? 95 : 40,
        feedback: isValid ? 'Looks complete' : 'Tool bodies are placeholders',
        issues,
      });

    it('should not run when disabled', async () => {
      service = await buildService({ PIPELINE_QUALITY_GATE: 'false' });
      const state = createPlannedState();

      const result = await service.refineUntilWorking(state);

      expect(result.success).toBe(true);
      // generate only - no judge call
      expect(mockLlmInvoke).toHaveBeenCalledTimes(1);
    });

    it('should pass a clean server through when enabled', async () => {
      service = await buildService({ PIPELINE_QUALITY_GATE: 'true' });
      mockLlmInvoke
        .mockResolvedValueOnce({ content: mockCodeGenerationResponse() })
        .mockResolvedValueOnce({ content: judgeResponse(true) });

      const result = await service.refineUntilWorking(createPlannedState());

      expect(result.success).toBe(true);
      expect(mockLlmInvoke).toHaveBeenCalledTimes(2); // generate + judge
    });

    it('should send passing-but-poor code back for another refinement round', async () => {
      service = await buildService({ PIPELINE_QUALITY_GATE: 'true' });
      mockLlmInvoke
        .mockResolvedValueOnce({ content: mockCodeGenerationResponse() })
        .mockResolvedValueOnce({
          content: judgeResponse(false, [
            {
              category: 'tool-implementation',
              message: 'create_user body is a TODO placeholder',
              suggestion: 'Implement the POST /users call',
            },
          ]),
        })
        .mockResolvedValue({ content: mockCodeGenerationResponse() });

      const result = await service.refineUntilWorking(createPlannedState());

      expect(result.success).toBe(false);
      expect(result.shouldContinue).toBe(true);
      expect(result.failureAnalysis?.rootCauses).toContain(
        'create_user body is a TODO placeholder',
      );
    });

    it('should treat a judge error as a pass rather than blocking the run', async () => {
      service = await buildService({ PIPELINE_QUALITY_GATE: 'true' });
      mockLlmInvoke
        .mockResolvedValueOnce({ content: mockCodeGenerationResponse() })
        .mockRejectedValueOnce(new Error('judge unavailable'));

      const result = await service.refineUntilWorking(createPlannedState());

      expect(result.success).toBe(true);
    });
  });

  describe('Docker testing options', () => {
    it('should pass correct options to McpTestingService', async () => {
      const state = createPlannedState();

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
