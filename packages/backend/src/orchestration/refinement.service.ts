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
 * MCP SDK Reference Implementation (Issue #140)
 *
 * This reference code is included in prompts to ensure the LLM uses correct
 * library APIs for @modelcontextprotocol/sdk and zod v3.
 *
 * Common API mistakes this prevents:
 * 1. StdioServerTransport({ stdin, stdout }) - WRONG, use StdioServerTransport()
 * 2. error.errors - WRONG, Zod v3 uses error.issues
 * 3. Missing type annotations causing TS7006 implicit any errors
 */
const MCP_REFERENCE_IMPLEMENTATION = `
**⚠️ CRITICAL: Use these EXACT patterns from @modelcontextprotocol/sdk and zod v3**

\`\`\`typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// 1. Server initialization (correct pattern)
const server = new Server(
  { name: "my-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// 2. Tool listing handler (correct pattern)
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "my_tool",
      description: "Description here",
      inputSchema: {
        type: "object",
        properties: {
          param1: { type: "string", description: "A parameter" },
        },
        required: ["param1"],
      },
    },
  ],
}));

// 3. Tool call handler with Zod validation (correct pattern)
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "my_tool") {
    try {
      // Zod validation with proper types
      const schema = z.object({ param1: z.string() });
      const validated = schema.parse(args);

      // Your tool logic here
      const result = \`Result for \${validated.param1}\`;

      // MCP response format (MUST use this exact structure)
      return {
        content: [{ type: "text", text: result }],
      };
    } catch (error) {
      // Zod v3 uses .issues NOT .errors
      if (error instanceof z.ZodError) {
        const messages = error.issues.map((issue: z.ZodIssue) =>
          \`\${issue.path.join(".")}: \${issue.message}\`
        ).join(", ");
        return {
          content: [{ type: "text", text: \`Validation error: \${messages}\` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: \`Error: \${error instanceof Error ? error.message : String(error)}\` }],
        isError: true,
      };
    }
  }

  return {
    content: [{ type: "text", text: \`Unknown tool: \${name}\` }],
    isError: true,
  };
});

// 4. Transport setup (NO ARGUMENTS - this is critical!)
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
\`\`\`

**Common Mistakes to AVOID:**
- ❌ \`new StdioServerTransport({ stdin: process.stdin, stdout: process.stdout })\` - WRONG
- ✅ \`new StdioServerTransport()\` - CORRECT (no arguments)
- ❌ \`error.errors.map(...)\` - WRONG (Zod v2 API)
- ✅ \`error.issues.map((issue: z.ZodIssue) => ...)\` - CORRECT (Zod v3 API)
- ❌ \`(e) => e.message\` - WRONG (implicit any in strict mode)
- ✅ \`(issue: z.ZodIssue) => issue.message\` - CORRECT (explicit type)
`;

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
  private readonly codeGenLlm: ChatAnthropic;

  constructor(
    private readonly mcpTestingService: McpTestingService,
    private readonly mcpGenerationService: McpGenerationService,
  ) {
    // Initialize Claude Haiku for failure analysis
    this.llm = new ChatAnthropic({
      modelName: 'claude-haiku-4-5-20251001',
      temperature: 0.7,
      topP: undefined, // Fix for @langchain/anthropic bug sending top_p: -1
      maxTokens: 16000, // Generous limit for detailed failure analysis
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    });

    // Separate LLM instance for code generation with maximum token limit
    // Claude Haiku 4.5 supports up to 64K output tokens
    // This prevents truncation of generated TypeScript files (Issue #136)
    this.codeGenLlm = new ChatAnthropic({
      modelName: 'claude-haiku-4-5-20251001',
      temperature: 0.3, // Lower temperature for more consistent code output
      topP: undefined,
      maxTokens: 64000, // Maximum output for Haiku 4.5 - no truncation
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
   * Respects user's tool count constraints (Issue #137).
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

    // Build constraint warning if user specified limits (Issue #137)
    let constraintWarning = '';
    if (state.requestedToolCount || state.requestedToolNames?.length) {
      constraintWarning = `\n**⚠️ CRITICAL: USER TOOL CONSTRAINTS**\n`;
      if (state.requestedToolCount) {
        constraintWarning += `- User explicitly requested ${state.requestedToolCount} tools\n`;
      }
      if (state.requestedToolNames?.length) {
        constraintWarning += `- User specifically requested: ${state.requestedToolNames.join(', ')}\n`;
      }
      constraintWarning += `- Implement EXACTLY the ${toolCount} tools listed below\n`;
      constraintWarning += `- Do NOT add extra tools, helpers, or "nice-to-have" functionality\n`;
    }

    const prompt = `Generate a complete TypeScript MCP server implementation.

**Server Name**: ${serverName}
${constraintWarning}
${MCP_REFERENCE_IMPLEMENTATION}

**Research Findings**:
${JSON.stringify(research?.webSearchFindings, null, 2)}

**Generation Plan**:
${JSON.stringify(plan, null, 2)}

**Tools to Implement** (EXACTLY ${toolCount} tools - no more, no less):
${toolsList}

**Requirements**:
1. Use @modelcontextprotocol/sdk for MCP protocol - FOLLOW THE REFERENCE IMPLEMENTATION EXACTLY
2. Implement EXACTLY ${toolCount} tools from the plan above - no additional tools
3. Use proper TypeScript types (no implicit any)
4. Include error handling using Zod v3 .issues (NOT .errors)
5. Follow MCP protocol exactly: return { content: [{ type: 'text', text: '...' }] }
6. Use axios for HTTP requests if needed
7. Include proper authentication handling
8. Use StdioServerTransport() with NO ARGUMENTS

**Output Format**: Return ONLY the complete TypeScript code, no explanations.
Start with imports.`;

    this.logger.log(`Prompt prepared for ${toolCount} valid tools (user constraint: ${state.requestedToolCount || 'none'})`);


    try {
      // Use codeGenLlm with higher token limit to prevent truncation (Issue #136)
      const response = await this.codeGenLlm.invoke(prompt);
      let code = response.content.toString();

      // Remove markdown code blocks if present
      const codeBlockMatch = code.match(/\`\`\`(?:typescript|ts)?\n([\s\S]*?)\n\`\`\`/);
      if (codeBlockMatch) {
        code = codeBlockMatch[1];
      }

      // Detect truncation: valid TypeScript files must end with proper structure
      const truncationDetected = this.detectTruncation(code);
      if (truncationDetected) {
        this.logger.warn(`Code truncation detected! Attempting recovery...`);
        code = this.attemptTruncationRecovery(code);
      }

      this.logger.log(`Generated main file: ${code.length} characters (truncation: ${truncationDetected})`);
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

${MCP_REFERENCE_IMPLEMENTATION}

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

${MCP_REFERENCE_IMPLEMENTATION}

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
2. Maintain MCP protocol compliance - FOLLOW THE REFERENCE IMPLEMENTATION:
   - Return { content: [{ type: 'text', text: '...' }] }
   - Use StdioServerTransport() with NO ARGUMENTS
   - Use Zod v3 .issues (NOT .errors) for validation errors
   - Include proper TypeScript types (no implicit any)
3. Preserve working tools (don't break what works)
4. Keep code structure and imports
5. Ensure TypeScript compiles without errors in strict mode

**Return Format**:
Return ONLY the complete corrected TypeScript code (no explanations, no markdown).
Start directly with the imports.`;

    try {
      // Use codeGenLlm with higher token limit to prevent truncation (Issue #136)
      const response = await this.codeGenLlm.invoke(prompt);
      const content = response.content.toString();

      // Extract TypeScript code (remove markdown if present)
      let refinedCode = content;
      const codeBlockMatch = content.match(/```(?:typescript|ts)?\n([\s\S]*?)\n```/);
      if (codeBlockMatch) {
        refinedCode = codeBlockMatch[1];
      }

      // Detect truncation and attempt recovery (Issue #136)
      const truncationDetected = this.detectTruncation(refinedCode);
      if (truncationDetected) {
        this.logger.warn(`Code truncation detected in refinement! Attempting recovery...`);
        refinedCode = this.attemptTruncationRecovery(refinedCode);
      }

      this.logger.log(`Code refined: ${refinedCode.length} characters (truncation: ${truncationDetected})`);

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

  /**
   * Detect Truncation
   *
   * Checks if generated TypeScript code appears to be truncated.
   * Valid MCP server files should end with proper structure.
   *
   * Detection heuristics:
   * 1. File should end with main() call or export
   * 2. Braces should be balanced
   * 3. No trailing incomplete statements
   *
   * @param code - Generated TypeScript code
   * @returns True if truncation detected
   */
  private detectTruncation(code: string): boolean {
    if (!code || code.length === 0) {
      return true;
    }

    const trimmedCode = code.trim();

    // Check 1: Valid TypeScript files should end with specific patterns
    const validEndings = [
      /main\(\)\.catch\([^)]*\);?\s*$/,           // main().catch(console.error);
      /main\(\);?\s*$/,                            // main();
      /export\s+\{[^}]*\};?\s*$/,                 // export { ... };
      /export\s+default\s+\w+;?\s*$/,             // export default X;
      /\}\s*$/,                                    // ends with closing brace
    ];

    const hasValidEnding = validEndings.some(pattern => pattern.test(trimmedCode));

    // Check 2: Brace balance (opening vs closing)
    const openBraces = (code.match(/\{/g) || []).length;
    const closeBraces = (code.match(/\}/g) || []).length;
    const bracesBalanced = openBraces === closeBraces;

    // Check 3: Parentheses balance
    const openParens = (code.match(/\(/g) || []).length;
    const closeParens = (code.match(/\)/g) || []).length;
    const parensBalanced = openParens === closeParens;

    // Check 4: Look for obvious truncation patterns
    const truncationPatterns = [
      /[=+\-*/%&|^!<>]\s*$/,    // ends with operator
      /,\s*$/,                   // ends with comma
      /\(\s*$/,                  // ends with open paren
      /\[\s*$/,                  // ends with open bracket
      /:\s*$/,                   // ends with colon
      /\.\s*$/,                  // ends with dot
      /=>\s*$/,                  // ends with arrow
      /\b(if|else|for|while|switch|try|catch|const|let|var|function|async|await|return)\s*$/i,
    ];

    const hasObviousTruncation = truncationPatterns.some(pattern => pattern.test(trimmedCode));

    // Truncation detected if any of these conditions fail
    const isTruncated = !hasValidEnding || !bracesBalanced || !parensBalanced || hasObviousTruncation;

    if (isTruncated) {
      this.logger.debug(`Truncation detection: validEnding=${hasValidEnding}, braces=${openBraces}/${closeBraces}, parens=${openParens}/${closeParens}, obviousTruncation=${hasObviousTruncation}`);
    }

    return isTruncated;
  }

  /**
   * Attempt Truncation Recovery
   *
   * Tries to fix truncated code by adding missing closing structures.
   * This is a best-effort recovery - the code may still not compile,
   * but the refinement loop will catch and fix remaining issues.
   *
   * @param code - Truncated TypeScript code
   * @returns Code with attempted fixes
   */
  private attemptTruncationRecovery(code: string): string {
    let fixedCode = code.trim();

    // Count unbalanced braces and add closing ones
    const openBraces = (fixedCode.match(/\{/g) || []).length;
    const closeBraces = (fixedCode.match(/\}/g) || []).length;
    const missingBraces = openBraces - closeBraces;

    if (missingBraces > 0) {
      this.logger.debug(`Adding ${missingBraces} missing closing braces`);
      fixedCode += '\n' + '}'.repeat(missingBraces);
    }

    // Count unbalanced parentheses
    const openParens = (fixedCode.match(/\(/g) || []).length;
    const closeParens = (fixedCode.match(/\)/g) || []).length;
    const missingParens = openParens - closeParens;

    if (missingParens > 0) {
      this.logger.debug(`Adding ${missingParens} missing closing parentheses`);
      // Insert before the closing braces we just added
      const insertPos = fixedCode.length - missingBraces;
      fixedCode = fixedCode.slice(0, insertPos) + ')'.repeat(missingParens) + fixedCode.slice(insertPos);
    }

    // Add main() call if missing and we have a main function
    if (!fixedCode.includes('main()') && fixedCode.includes('async function main')) {
      this.logger.debug('Adding missing main() call');
      fixedCode += '\n\nmain().catch(console.error);';
    }

    this.logger.log(`Truncation recovery: added ${missingBraces} braces, ${missingParens} parens`);
    return fixedCode;
  }
}
