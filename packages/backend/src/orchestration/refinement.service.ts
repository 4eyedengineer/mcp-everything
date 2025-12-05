import { Injectable, Logger } from '@nestjs/common';
import { ChatAnthropic } from '@langchain/anthropic';
import { McpTestingService, GeneratedCode, McpServerTestResult } from '../testing/mcp-testing.service';
import { McpGenerationService } from '../mcp-generation.service';
import {
  GraphState,
  FailureAnalysis,
} from './types';
import { getPlatformContextPrompt } from './platform-context';
import { safeParseJSON } from './json-utils';

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
      modelName: 'claude-haiku-4-5-20251001',
      temperature: 0.7,
      topP: undefined, // Fix for @langchain/anthropic bug sending top_p: -1
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
   * Priority:
   * 1. If ensemble has discovered tools (in generationPlan.toolsToGenerate) - use them
   * 2. Otherwise, fall back to McpGenerationService for GitHub URLs
   *
   * @param state - Graph state with generation plan
   * @returns Generated code structure
   */
  private async generateInitialCode(state: GraphState): Promise<GeneratedCode> {
    const plan = state.generationPlan;
    if (!plan) {
      throw new Error('No generation plan available');
    }

    // PRIORITY: If ensemble already discovered tools, use generateFromPlan
    // This respects the ensemble's work and avoids duplicate tool discovery
    if (plan.toolsToGenerate && plan.toolsToGenerate.length > 0) {
      this.logger.log(`Using ${plan.toolsToGenerate.length} tools from ensemble for MCP server generation`);
      return await this.generateFromPlan(state);
    }

    // Fallback: Use McpGenerationService for GitHub URLs when no ensemble tools exist
    const githubUrl = state.extractedData?.githubUrl;
    if (githubUrl && githubUrl.trim().length > 0 && githubUrl.includes('github.com')) {
      this.logger.log(`Generating MCP server from GitHub repository (no ensemble tools): ${githubUrl}`);
      const generated = await this.mcpGenerationService.generateMCPServer(githubUrl);
      return this.convertToGeneratedCode(generated);
    }

    // No tools available and no GitHub URL - cannot generate
    throw new Error('No tools available for MCP server generation. Ensemble did not produce tools and no GitHub URL provided.');
  }

  /**
   * Generate From Plan
   *
   * Generates MCP server code directly from research findings and generation plan
   * when no GitHub URL is provided (e.g., service name requests like "Stripe API").
   *
   * @param state - Graph state with research and generation plan
   * @returns Generated code structure
   */
  private async generateFromPlan(state: GraphState): Promise<GeneratedCode> {
    const plan = state.generationPlan!;
    const research = state.researchPhase;

    // Validate that we have tools to generate
    if (!plan.toolsToGenerate || plan.toolsToGenerate.length === 0) {
      throw new Error('No tools specified in generation plan. Cannot generate MCP server without tools.');
    }

    // Extract service name from user input or research
    const serviceName = state.userInput.match(/(?:for|with)\s+(?:the\s+)?([A-Z][a-zA-Z\s]+(?:API|api))/)?.[1]
      || research?.synthesizedPlan?.summary?.match(/([A-Z][a-zA-Z\s]+(?:API|api))/)?.[1]
      || 'API';

    const serverName = serviceName.toLowerCase().replace(/\s+/g, '-').replace(/api$/i, '') + '-mcp';

    this.logger.log(`Generating MCP server "${serverName}" with ${plan.toolsToGenerate.length} tools`);

    // Generate TypeScript MCP server code using LLM
    const mainFile = await this.generateMainFile(state, serverName);
    const packageJson = this.generatePackageJson({ serverName, tools: plan.toolsToGenerate });
    const tsConfig = this.generateTsConfig();

    // Filter out any undefined tools and validate structure
    const validTools = plan.toolsToGenerate
      .filter(t => t && t.name && t.description)
      .map(t => ({
        name: t.name,
        inputSchema: t.parameters || {},
        description: t.description
      }));

    if (validTools.length === 0) {
      throw new Error('No valid tools found in generation plan');
    }

    return {
      mainFile,
      packageJson,
      tsConfig,
      supportingFiles: {},
      metadata: {
        tools: validTools,
        iteration: 1,
        serverName,
      },
    };
  }

  /**
   * Generate Main File
   *
   * Uses LLM to generate the main TypeScript file for the MCP server
   * based on research findings and generation plan.
   *
   * @param state - Graph state with research and plan
   * @param serverName - Name of the MCP server
   * @returns Generated TypeScript code
   */
  private async generateMainFile(state: GraphState, serverName: string): Promise<string> {
    const plan = state.generationPlan!;
    const research = state.researchPhase;

    // Validate tools exist
    if (!plan.toolsToGenerate || plan.toolsToGenerate.length === 0) {
      throw new Error('Cannot generate main file without tools in generation plan');
    }

    // Filter out any undefined or invalid tools
    const validTools = plan.toolsToGenerate.filter(t => t && t.name && t.description);

    if (validTools.length === 0) {
      throw new Error('No valid tools with name and description found in generation plan');
    }

    const toolCount = validTools.length;
    const toolsList = validTools.map(t => `- ${t.name}: ${t.description}`).join('\n');

    const prompt = `Generate a complete TypeScript MCP server implementation.

**Server Name**: ${serverName}

**Research Findings**:
${JSON.stringify(research?.webSearchFindings, null, 2)}

**Generation Plan**:
${JSON.stringify(plan, null, 2)}

**Tools to Implement** (${toolCount} total):
${toolsList}

**Requirements**:
1. Use @modelcontextprotocol/sdk for MCP protocol
2. Implement ALL ${toolCount} tools from the plan above
3. Use proper TypeScript types
4. Include error handling for all tools
5. Follow MCP protocol exactly: return { content: [{ type: 'text', text: '...' }] }
6. Use axios for HTTP requests if needed
7. Include proper authentication handling

**Output Format**: Return ONLY the complete TypeScript code, no explanations.
Start with imports.`;

    this.logger.log(`Prompt prepared for ${toolCount} valid tools`);


    try {
      const response = await this.llm.invoke(prompt);
      let code = response.content.toString();

      // Remove markdown code blocks if present
      const codeBlockMatch = code.match(/\`\`\`(?:typescript|ts)?\n([\s\S]*?)\n\`\`\`/);
      if (codeBlockMatch) {
        code = codeBlockMatch[1];
      }

      this.logger.log(`Generated main file: ${code.length} characters`);
      return code;
    } catch (error) {
      this.logger.error(`Code generation failed: ${error.message}`);
      throw new Error(`Failed to generate MCP server code: ${error.message}`);
    }
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
    // Handle GeneratedServer structure from McpGenerationService
    // GeneratedServer has: files[], metadata.tools, serverName
    // We need to convert to: mainFile, packageJson, tsConfig, supportingFiles, metadata

    // Extract main file from files array if available
    let mainFile = generated.mainFile || generated.code || '';
    let packageJson = generated.packageJson;
    let tsConfig = generated.tsConfig;
    const supportingFiles: Record<string, string> = generated.supportingFiles || {};

    // If files array exists (GeneratedServer format), extract from there
    if (generated.files && Array.isArray(generated.files)) {
      for (const file of generated.files) {
        if (file.path === 'src/index.ts' || file.path.endsWith('/index.ts')) {
          mainFile = file.content;
        } else if (file.path === 'package.json') {
          packageJson = file.content;
        } else if (file.path === 'tsconfig.json') {
          tsConfig = file.content;
        } else {
          // Store other files as supporting files
          supportingFiles[file.path] = file.content;
        }
      }
    }

    // Extract tools - check metadata.tools first (GeneratedServer), then root tools
    const tools = generated.metadata?.tools || generated.tools || [];

    return {
      mainFile,
      packageJson: packageJson || this.generatePackageJson(generated),
      tsConfig: tsConfig || this.generateTsConfig(),
      supportingFiles,
      metadata: {
        tools,
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
          'zod': '^3.23.0',
          'axios': '^1.7.0',
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

    const prompt = `${getPlatformContextPrompt()}

**Your Role**: Debug and fix MCP server issues with surgical precision. Focus on root causes, not symptoms.

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

      // Extract JSON using safe bracket-balanced parsing
      const analysis = safeParseJSON<FailureAnalysis>(content, this.logger);

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
    const prompt = `${getPlatformContextPrompt()}

**Your Role**: Fix MCP server code efficiently. Apply systematic fixes that address root causes.

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
