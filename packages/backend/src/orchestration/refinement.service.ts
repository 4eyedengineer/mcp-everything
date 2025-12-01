import { Injectable, Logger } from '@nestjs/common';
import { ChatAnthropic } from '@langchain/anthropic';
import { McpTestingService, GeneratedCode, McpServerTestResult } from '../testing/mcp-testing.service';
import { McpGenerationService } from '../mcp-generation.service';
import {
  GraphState,
  FailureAnalysis,
} from './types';

/**
 * Refinement Service
 *
 * Orchestrates Phase 4: Generate-Test-Refine Loop
 *
 * Responsibilities:
 * - Generate MCP server code from ensemble plan
 * - Test using Docker-based McpTestingService
 * - Analyze failures using AI
 * - Refine code based on failure analysis
 * - Iterate until all tools work (max 5 iterations)
 * - Stream progress in real-time
 *
 * Flow:
 * 1. Generate MCP server code (or use existing from state)
 * 2. Test in Docker container via MCP protocol
 * 3. If all tools work: SUCCESS, return code
 * 4. If failures: AI analyzes root causes
 * 5. AI refines code to fix issues
 * 6. Increment iteration counter
 * 7. If iteration < 5: Go to step 2
 * 8. If iteration >= 5: Return best attempt
 *
 * Success Criteria:
 * - All tools pass MCP protocol testing
 * - Build succeeds
 * - No runtime errors
 *
 * Iteration Limit:
 * - Max 5 iterations (prevents infinite loops)
 * - 90% of servers converge within 5 iterations (estimated)
 * - Graceful degradation if convergence fails
 */
@Injectable()
export class RefinementService {
  private readonly logger = new Logger(RefinementService.name);
  private readonly llm: ChatAnthropic;

  constructor(
    private readonly mcpTestingService: McpTestingService,
    private readonly mcpGenerationService: McpGenerationService,
  ) {
    // Initialize Claude Haiku for failure analysis and code refinement
    this.llm = new ChatAnthropic({
      modelName: 'claude-3-5-haiku-20241022',
      temperature: 0.7,
      maxTokens: 4096,
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    });
  }

  /**
   * Refine Until Working
   *
   * Main entry point for refinement loop.
   * Iterates up to 5 times to get working MCP server.
   *
   * @param state - Current graph state with generation plan
   * @returns Refinement result with final code and test results
   */
  async refineUntilWorking(state: GraphState): Promise<{
    success: boolean;
    generatedCode: GeneratedCode;
    testResults: McpServerTestResult;
    failureAnalysis?: FailureAnalysis;
    iterations: number;
    shouldContinue: boolean;
    error?: string;
  }> {
    const maxIterations = 5;
    const iteration = (state.refinementIteration || 0) + 1;

    this.logger.log(`Starting refinement iteration ${iteration}/${maxIterations}`);

    // Step 1: Generate or use existing code
    const generatedCode = state.generatedCode
      ? this.convertToGeneratedCode(state.generatedCode)
      : await this.generateInitialCode(state);

    // Step 2: Test MCP server in Docker
    this.logger.log(`Testing MCP server: ${generatedCode.metadata.tools.length} tools`);
    const testResults = await this.mcpTestingService.testMcpServer(
      generatedCode,
      {
        cpuLimit: '0.5',
        memoryLimit: '512m',
        timeout: 30,
        toolTimeout: 5,
        networkMode: 'none',
        cleanup: true,
      }
    );

    // Step 3: Check if all tools work
    if (testResults.overallSuccess && testResults.toolsPassedCount === testResults.toolsFound) {
      this.logger.log(
        `✅ SUCCESS! All ${testResults.toolsPassedCount} tools work (iteration ${iteration})`
      );

      return {
        success: true,
        generatedCode,
        testResults,
        iterations: iteration,
        shouldContinue: false,
      };
    }

    // Step 4: Check max iterations
    if (iteration >= maxIterations) {
      this.logger.warn(
        `Max iterations (${maxIterations}) reached. ${testResults.toolsPassedCount}/${testResults.toolsFound} tools passed.`
      );

      return {
        success: false,
        generatedCode,
        testResults,
        iterations: iteration,
        shouldContinue: false,
        error: `Failed to converge after ${maxIterations} iterations. Best attempt: ${testResults.toolsPassedCount}/${testResults.toolsFound} tools working.`,
      };
    }

    // Step 5: Analyze failures
    this.logger.log(`Analyzing ${testResults.toolsFound - testResults.toolsPassedCount} failures`);
    const failureAnalysis = await this.analyzeFailures(testResults, generatedCode);

    // Step 6: Refine code
    this.logger.log(`Refining code based on ${failureAnalysis.fixes.length} fixes`);
    const refinedCode = await this.refineCode(
      generatedCode,
      failureAnalysis,
      state.generationPlan!
    );

    // Step 7: Continue loop
    return {
      success: false,
      generatedCode: refinedCode,
      testResults,
      failureAnalysis,
      iterations: iteration,
      shouldContinue: true,
    };
  }

  /**
   * Generate Initial Code
   *
   * Creates first version of MCP server from generation plan.
   *
   * @param state - Graph state with generation plan
   * @returns Generated code structure
   */
  private async generateInitialCode(state: GraphState): Promise<GeneratedCode> {
    const plan = state.generationPlan;
    if (!plan) {
      throw new Error('No generation plan available');
    }

    // Use existing McpGenerationService
    const githubUrl = state.extractedData?.githubUrl!;
    const generated = await this.mcpGenerationService.generateMCPServer(githubUrl);

    // Convert to GeneratedCode format
    return this.convertToGeneratedCode(generated);
  }

  /**
   * Convert to Generated Code
   *
   * Converts McpGenerationService output to GeneratedCode format.
   *
   * @param generated - Output from McpGenerationService
   * @returns GeneratedCode structure
   */
  private convertToGeneratedCode(generated: any): GeneratedCode {
    return {
      mainFile: generated.mainFile || generated.code || '',
      packageJson: generated.packageJson || this.generatePackageJson(generated),
      tsConfig: generated.tsConfig || this.generateTsConfig(),
      supportingFiles: generated.supportingFiles || {},
      metadata: {
        tools: generated.tools || [],
        iteration: generated.iteration || 1,
        serverName: generated.serverName || 'mcp-server',
      },
    };
  }

  /**
   * Generate Package.json
   *
   * Creates default package.json for MCP server.
   *
   * @param generated - Generated code context
   * @returns package.json string
   */
  private generatePackageJson(generated: any): string {
    return JSON.stringify(
      {
        name: generated.serverName || 'mcp-server',
        version: '1.0.0',
        type: 'module',
        main: 'dist/index.js',
        scripts: {
          build: 'tsc',
          start: 'node dist/index.js',
        },
        dependencies: {
          '@modelcontextprotocol/sdk': '^0.5.0',
        },
        devDependencies: {
          '@types/node': '^20.0.0',
          typescript: '^5.0.0',
        },
      },
      null,
      2
    );
  }

  /**
   * Generate TSConfig
   *
   * Creates default tsconfig.json for MCP server.
   *
   * @returns tsconfig.json string
   */
  private generateTsConfig(): string {
    return JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'Node16',
          moduleResolution: 'Node16',
          outDir: './dist',
          rootDir: './src',
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
        },
        include: ['src/**/*'],
      },
      null,
      2
    );
  }

  /**
   * Analyze Failures
   *
   * Uses AI to analyze test failures and recommend fixes.
   *
   * Analysis Categories:
   * - Syntax errors (build failures)
   * - Runtime errors (exceptions during execution)
   * - MCP protocol violations (invalid responses)
   * - Logic errors (incorrect tool behavior)
   * - Timeout errors (tools taking too long)
   *
   * @param testResults - Test execution results
   * @param generatedCode - Original generated code
   * @returns Failure analysis with categorized fixes
   */
  private async analyzeFailures(
    testResults: McpServerTestResult,
    generatedCode: GeneratedCode
  ): Promise<FailureAnalysis> {
    const failures = testResults.results.filter(r => !r.success);

    const prompt = `You are an expert at debugging MCP servers and fixing code issues.

Analyze test failures and provide specific fixes.

**MCP Server Metadata**:
- Server Name: ${generatedCode.metadata.serverName}
- Tools: ${generatedCode.metadata.tools.length}
- Iteration: ${generatedCode.metadata.iteration}

**Test Results**:
- Total Tools: ${testResults.toolsFound}
- Passed: ${testResults.toolsPassedCount}
- Failed: ${testResults.toolsFound - testResults.toolsPassedCount}
- Build Success: ${testResults.buildSuccess}

${testResults.buildError ? `**Build Error**:\n${testResults.buildError}\n` : ''}

**Tool Failures**:
${failures.map((f, i) => `
${i + 1}. Tool: ${f.toolName}
   - Error: ${f.error}
   - MCP Compliant: ${f.mcpCompliant}
   - Execution Time: ${f.executionTime}ms
`).join('\n')}

**Task**: Analyze root causes and provide specific fixes.

**Failure Categories**:
1. **Syntax**: TypeScript compilation errors, import issues
2. **Runtime**: Exceptions during execution, undefined variables
3. **MCP Protocol**: Invalid JSON-RPC responses, missing fields
4. **Logic**: Incorrect implementation, wrong outputs
5. **Timeout**: Tools taking >5 seconds

**Output Format** (STRICT JSON):
\`\`\`json
{
  "failureCount": number,
  "categories": [
    { "type": "syntax|runtime|mcp_protocol|logic|timeout", "count": number }
  ],
  "rootCauses": [
    "Specific description of root cause"
  ],
  "fixes": [
    {
      "toolName": "tool_name",
      "issue": "Specific issue description",
      "solution": "Specific code fix or change needed",
      "priority": "HIGH|MEDIUM|LOW",
      "codeSnippet": "Optional: Example code showing the fix"
    }
  ],
  "recommendation": "Overall strategy for fixing all issues"
}
\`\`\`

**Quality Guidelines**:
- Be specific: "Missing 'result' field in MCP response" not "Protocol error"
- Provide actionable solutions: Show exact code changes
- Prioritize: HIGH = blocks other tools, MEDIUM = this tool only, LOW = minor issue
- Root causes should identify SYSTEMIC issues affecting multiple tools

**Example Good Analysis**:
{
  "fixes": [{
    "toolName": "get_user",
    "issue": "MCP response missing 'content' array in result",
    "solution": "Return { content: [{ type: 'text', text: JSON.stringify(result) }] } instead of raw result",
    "priority": "HIGH",
    "codeSnippet": "return { content: [{ type: 'text', text: JSON.stringify(userData) }] };"
  }]
}

Return ONLY valid JSON with failure analysis.`;

    try {
      const response = await this.llm.invoke(prompt);
      const content = response.content.toString();

      // Extract JSON
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in AI response');
      }

      const analysis: FailureAnalysis = JSON.parse(jsonMatch[0]);

      this.logger.log(
        `Failure analysis: ${analysis.rootCauses.length} root causes, ${analysis.fixes.length} fixes`
      );

      return analysis;
    } catch (error) {
      this.logger.error(`Failure analysis failed: ${error.message}`);

      // Fallback: Basic analysis from test results
      return {
        failureCount: failures.length,
        categories: [{ type: 'runtime', count: failures.length }],
        rootCauses: failures.map(f => f.error || 'Unknown error'),
        fixes: failures.map(f => ({
          toolName: f.toolName,
          issue: f.error || 'Tool failed',
          solution: 'Review tool implementation and ensure MCP protocol compliance',
          priority: 'HIGH',
        })),
        recommendation: 'Review and fix each failing tool individually',
      };
    }
  }

  /**
   * Refine Code
   *
   * Uses AI to apply fixes from failure analysis to generated code.
   *
   * Strategy:
   * - Focus on HIGH priority fixes first
   * - Apply systematic fixes (e.g., all tools need same MCP response format)
   * - Preserve working tools
   * - Maintain code structure and style
   *
   * @param generatedCode - Original generated code
   * @param failureAnalysis - Analysis of what needs fixing
   * @param plan - Original generation plan
   * @returns Refined code
   */
  private async refineCode(
    generatedCode: GeneratedCode,
    failureAnalysis: FailureAnalysis,
    plan: GraphState['generationPlan']
  ): Promise<GeneratedCode> {
    const prompt = `You are an expert MCP server developer. Fix the code based on test failures.

**Original Code**:
\`\`\`typescript
${generatedCode.mainFile}
\`\`\`

**Test Failures**: ${failureAnalysis.failureCount} tools failed

**Root Causes**:
${failureAnalysis.rootCauses.map((c, i) => `${i + 1}. ${c}`).join('\n')}

**Required Fixes** (Priority Order):
${failureAnalysis.fixes
  .sort((a, b) => {
    const priorityOrder = { HIGH: 3, MEDIUM: 2, LOW: 1 };
    return priorityOrder[b.priority] - priorityOrder[a.priority];
  })
  .map((f, i) => `
${i + 1}. **${f.toolName}** (${f.priority}):
   - Issue: ${f.issue}
   - Solution: ${f.solution}
   ${f.codeSnippet ? `- Example: ${f.codeSnippet}` : ''}
`).join('\n')}

**Recommendation**: ${failureAnalysis.recommendation}

**Task**: Return the COMPLETE corrected TypeScript code.

**Requirements**:
1. Fix ALL issues listed above
2. Maintain MCP protocol compliance:
   - Return { content: [{ type: 'text', text: '...' }] }
   - Include proper error handling
   - Use JSON-RPC 2.0 format
3. Preserve working tools (don't break what works)
4. Keep code structure and imports
5. Ensure TypeScript compiles without errors

**Return Format**:
Return ONLY the complete corrected TypeScript code (no explanations, no markdown).
Start directly with the imports.`;

    try {
      const response = await this.llm.invoke(prompt);
      const content = response.content.toString();

      // Extract TypeScript code (remove markdown if present)
      let refinedCode = content;
      const codeBlockMatch = content.match(/```(?:typescript|ts)?\n([\s\S]*?)\n```/);
      if (codeBlockMatch) {
        refinedCode = codeBlockMatch[1];
      }

      this.logger.log(`Code refined: ${refinedCode.length} characters`);

      // Return new GeneratedCode with refined main file
      return {
        ...generatedCode,
        mainFile: refinedCode,
        metadata: {
          ...generatedCode.metadata,
          iteration: generatedCode.metadata.iteration + 1,
        },
      };
    } catch (error) {
      this.logger.error(`Code refinement failed: ${error.message}`);

      // Fallback: Return original code (will likely fail again, but graceful)
      return generatedCode;
    }
  }
}
