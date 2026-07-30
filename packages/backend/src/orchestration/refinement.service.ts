import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as ts from 'typescript';
import * as z from 'zod/v4';
import {
  McpTestingService,
  GeneratedCode,
  McpServerTestResult,
} from '../testing/mcp-testing.service';
import {
  McpProtocolValidatorService,
  McpProtocolValidationResult,
} from '../validation/mcp-protocol-validator.service';
import { PipelineState, FailureAnalysis, CodeQualityJudgement } from './types';
import { getPlatformContextPrompt } from './platform-context';
import { AnthropicService } from '../ai/anthropic.service';
import { TruncatedResponseError } from '../ai/anthropic.errors';

/**
 * Code quality judge output contract (enforced by the API's structured outputs).
 */
const CodeQualityJudgementSchema = z.object({
  isValid: z.boolean(),
  score: z.number(),
  feedback: z.string(),
  issues: z.array(
    z.object({
      category: z.enum(['typescript', 'mcp-protocol', 'tool-implementation', 'code-quality']),
      message: z.string(),
      suggestion: z.string(),
    }),
  ),
});

/**
 * Failure analysis output contract (enforced by the API's structured outputs).
 */
const FailureAnalysisSchema = z.object({
  failureCount: z.number(),
  categories: z.array(
    z.object({
      type: z.enum(['syntax', 'runtime', 'mcp_protocol', 'logic', 'timeout']),
      count: z.number(),
    }),
  ),
  rootCauses: z.array(z.string()),
  fixes: z.array(
    z.object({
      toolName: z.string(),
      issue: z.string(),
      solution: z.string(),
      priority: z.enum(['HIGH', 'MEDIUM', 'LOW']),
      codeSnippet: z.string().nullable().optional(),
    }),
  ),
  recommendation: z.string(),
});

/**
 * Output caps for code generation. The first attempt is generous; if the model
 * still hits the cap we retry once at the model's ceiling rather than trying to
 * "repair" a truncated file.
 */
const CODE_GEN_MAX_TOKENS = 64000;
const CODE_GEN_RETRY_MAX_TOKENS = 128000;
const ANALYSIS_MAX_TOKENS = 16000;

/**
 * MCP SDK Reference Implementation (Issue #140)
 *
 * This reference code is included in prompts to ensure the LLM uses correct
 * library APIs for @modelcontextprotocol/sdk and zod v3.
 *
 * Re-verified 2026-07 against @modelcontextprotocol/sdk 1.x (npm latest:
 * 1.30.0): Server + setRequestHandler, no-arg StdioServerTransport, and the
 * ListToolsRequestSchema/CallToolRequestSchema low-level handler pattern are
 * all unchanged from the 0.x line this reference was written against. Only
 * declares the `tools` server capability, which remains correct - `roots`,
 * `sampling`, and `logging` as *server* capabilities were deprecated in the
 * 2026-07-28 MCP spec revision.
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
// Only declare capabilities this server actually implements. Declare
// \`tools\` here; do NOT declare \`roots\`, \`sampling\`, or \`logging\` as
// *server* capabilities - those were deprecated in the MCP spec.
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
 * The `refine` step of the generation pipeline: Generate-Test-Refine Loop
 *
 * Responsibilities:
 * - Generate MCP server code from the planned tool set
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
 * - LLM-as-judge quality gate passes (PIPELINE_QUALITY_GATE, default on)
 *
 * Iteration Limit:
 * - Max 5 iterations (prevents infinite loops)
 * - 90% of servers converge within 5 iterations (estimated)
 * - Graceful degradation if convergence fails
 */
@Injectable()
export class RefinementService {
  private readonly logger = new Logger(RefinementService.name);

  /** LLM-as-judge quality gate; on by default, disable with PIPELINE_QUALITY_GATE=false. */
  private readonly qualityGateEnabled: boolean;

  constructor(
    private readonly mcpTestingService: McpTestingService,
    private readonly anthropic: AnthropicService,
    @Optional() private readonly configService?: ConfigService,
    @Optional() private readonly mcpProtocolValidator?: McpProtocolValidatorService,
  ) {
    this.qualityGateEnabled =
      String(this.configService?.get<string>('PIPELINE_QUALITY_GATE') ?? 'true').toLowerCase() !==
      'false';
  }

  /**
   * Generate code with the configured model, retrying once at a higher output
   * cap if the response was truncated.
   *
   * Truncation is reported by the API (`stop_reason: "max_tokens"`) and surfaced
   * as a TruncatedResponseError - we never brace-balance or fabricate the tail
   * of a cut-off file.
   */
  private async generateCode(prompt: string, caller: string): Promise<string> {
    try {
      return await this.anthropic.completeText({
        prompt,
        maxTokens: CODE_GEN_MAX_TOKENS,
        caller,
      });
    } catch (error) {
      if (!(error instanceof TruncatedResponseError)) {
        throw error;
      }

      this.logger.warn(
        `${caller} truncated at ${CODE_GEN_MAX_TOKENS} output tokens, ` +
          `retrying at ${CODE_GEN_RETRY_MAX_TOKENS}`,
      );

      return this.anthropic.completeText({
        prompt,
        maxTokens: CODE_GEN_RETRY_MAX_TOKENS,
        caller: `${caller}.retry`,
      });
    }
  }

  /** Strip a fenced TypeScript code block, if the model wrapped its output. */
  private stripCodeFence(text: string): string {
    const codeBlockMatch = text.match(/```(?:typescript|ts)?\n([\s\S]*?)\n```/);
    return codeBlockMatch ? codeBlockMatch[1] : text;
  }

  /**
   * Refine Until Working
   *
   * Main entry point for refinement loop.
   * Iterates up to 5 times to get working MCP server.
   *
   * @param state - Current pipeline state with generation plan
   * @returns Refinement result with final code and test results
   */
  async refineUntilWorking(state: PipelineState): Promise<{
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
    const testResults = await this.mcpTestingService.testMcpServer(generatedCode, {
      cpuLimit: '0.5',
      memoryLimit: '512m',
      timeout: 30,
      toolTimeout: 5,
      networkMode: 'none',
      cleanup: true,
    });

    // Step 3: Check if all tools work
    if (testResults.overallSuccess && testResults.toolsPassedCount === testResults.toolsFound) {
      // Step 3b: Run protocol compliance validation if available
      let protocolValid = true;
      let protocolValidation: McpProtocolValidationResult | null = null;

      if (this.mcpProtocolValidator) {
        this.logger.log(`Running MCP protocol compliance validation...`);
        try {
          protocolValidation = await this.mcpProtocolValidator.validateServer({
            mainFile: generatedCode.mainFile,
            packageJson: generatedCode.packageJson,
            tsConfig: generatedCode.tsConfig,
            metadata: {
              tools: generatedCode.metadata.tools,
              serverName: generatedCode.metadata.serverName,
            },
          });

          protocolValid = protocolValidation.valid;

          if (protocolValid) {
            this.logger.log(
              `✅ Protocol validation PASSED (${protocolValidation.checks.filter((c) => c.passed).length}/${protocolValidation.checks.length} checks)`,
            );
          } else {
            this.logger.warn(
              `⚠️ Protocol validation FAILED: ${protocolValidation.errors.join(', ')}`,
            );
          }
        } catch (validationError) {
          const errorMsg =
            validationError instanceof Error ? validationError.message : String(validationError);
          this.logger.warn(`Protocol validation error: ${errorMsg}`);
          // Don't fail on validation errors, just log
          protocolValid = true;
        }
      }

      // Only succeed if tool tests, protocol validation AND the quality gate pass
      if (protocolValid) {
        const judgement = await this.runQualityGate(generatedCode, state);

        if (judgement && !judgement.isValid && iteration < maxIterations) {
          this.logger.warn(
            `Tools and protocol pass but quality gate failed (score ${judgement.score}) - continuing refinement`,
          );

          const qualityFailures = this.toFailureAnalysis(judgement, generatedCode);
          const refinedCode = await this.refineCode(
            generatedCode,
            qualityFailures,
            state.generationPlan!,
          );

          return {
            success: false,
            generatedCode: refinedCode,
            testResults,
            failureAnalysis: qualityFailures,
            iterations: iteration,
            shouldContinue: true,
          };
        }

        this.logger.log(
          `✅ SUCCESS! All ${testResults.toolsPassedCount} tools work (iteration ${iteration})`,
        );

        return {
          success: true,
          generatedCode,
          testResults,
          iterations: iteration,
          shouldContinue: false,
        };
      } else {
        // Protocol validation failed - treat as failure and continue refinement
        this.logger.warn(`Tools pass but protocol validation failed - continuing refinement`);

        // Convert protocol validation failures to failure analysis
        const protocolFailures: FailureAnalysis = {
          failureCount: protocolValidation?.errors.length || 1,
          categories: [{ type: 'mcp_protocol', count: protocolValidation?.errors.length || 1 }],
          rootCauses: protocolValidation?.errors || ['Protocol validation failed'],
          fixes:
            protocolValidation?.checks
              .filter((c) => !c.passed)
              .map((c) => ({
                toolName: c.name.includes(':') ? c.name.split(':')[1] : 'server',
                issue: c.message,
                solution: `Fix ${c.name} compliance issue`,
                priority: 'HIGH' as const,
              })) || [],
          recommendation: 'Fix MCP protocol compliance issues identified by validation',
        };

        // Continue to refinement with protocol-specific fixes
        const refinedCode = await this.refineCode(
          generatedCode,
          protocolFailures,
          state.generationPlan!,
        );

        return {
          success: false,
          generatedCode: refinedCode,
          testResults,
          failureAnalysis: protocolFailures,
          iterations: iteration,
          shouldContinue: iteration < maxIterations,
        };
      }
    }

    // Step 4: Check max iterations
    if (iteration >= maxIterations) {
      this.logger.warn(
        `Max iterations (${maxIterations}) reached. ${testResults.toolsPassedCount}/${testResults.toolsFound} tools passed.`,
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
      state.generationPlan!,
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
   * Creates the first version of the MCP server from the planned tool set.
   *
   * @param state - Pipeline state with generation plan
   * @returns Generated code structure
   */
  private async generateInitialCode(state: PipelineState): Promise<GeneratedCode> {
    const plan = state.generationPlan;
    if (!plan) {
      throw new Error('No generation plan available');
    }

    if (!plan.toolsToGenerate || plan.toolsToGenerate.length === 0) {
      throw new Error(
        'No tools available for MCP server generation - the planning step produced none.',
      );
    }

    this.logger.log(`Using ${plan.toolsToGenerate.length} planned tools for MCP server generation`);
    return this.generateFromPlan(state);
  }

  /**
   * Generate From Plan
   *
   * Generates MCP server code from research findings and the planned tool set.
   *
   * @param state - Pipeline state with research and generation plan
   * @returns Generated code structure
   */
  private async generateFromPlan(state: PipelineState): Promise<GeneratedCode> {
    const plan = state.generationPlan!;
    const research = state.researchPhase;

    // Validate that we have tools to generate
    if (!plan.toolsToGenerate || plan.toolsToGenerate.length === 0) {
      throw new Error(
        'No tools specified in generation plan. Cannot generate MCP server without tools.',
      );
    }

    // The planner names the server; fall back to deriving it from the request.
    const serviceName =
      state.userInput.match(/(?:for|with)\s+(?:the\s+)?([A-Z][a-zA-Z\s]+(?:API|api))/)?.[1] ||
      research?.synthesizedPlan?.summary?.match(/([A-Z][a-zA-Z\s]+(?:API|api))/)?.[1] ||
      'API';

    const serverName =
      plan.serverName ||
      serviceName.toLowerCase().replace(/\s+/g, '-').replace(/api$/i, '') + '-mcp';

    this.logger.log(
      `Generating MCP server "${serverName}" with ${plan.toolsToGenerate.length} tools`,
    );

    // Generate TypeScript MCP server code using LLM
    const mainFile = await this.generateMainFile(state, serverName);
    const packageJson = this.generatePackageJson({ serverName, tools: plan.toolsToGenerate });
    const tsConfig = this.generateTsConfig();

    // Filter out any undefined tools and validate structure
    const validTools = plan.toolsToGenerate
      .filter((t) => t && t.name && t.description)
      .map((t) => ({
        name: t.name,
        inputSchema: t.parameters || {},
        description: t.description,
      }));

    if (validTools.length === 0) {
      throw new Error('No valid tools found in generation plan');
    }

    return {
      mainFile,
      packageJson,
      tsConfig,
      // Every generated server needs a Dockerfile: container-registry.service.ts
      // runs `docker build` directly against the on-disk server directory when
      // deploying. This is the initial generation path, so emitting them here is
      // required - convertToGeneratedCode only covers refinement iterations 2+.
      supportingFiles: {
        Dockerfile: this.generateDockerfile(),
        '.dockerignore': this.generateDockerignore(),
      },
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
   * @param state - Pipeline state with research and plan
   * @param serverName - Name of the MCP server
   * @returns Generated TypeScript code
   */
  private async generateMainFile(state: PipelineState, serverName: string): Promise<string> {
    const plan = state.generationPlan!;
    const research = state.researchPhase;

    // Validate tools exist
    if (!plan.toolsToGenerate || plan.toolsToGenerate.length === 0) {
      throw new Error('Cannot generate main file without tools in generation plan');
    }

    // Filter out any undefined or invalid tools
    const validTools = plan.toolsToGenerate.filter((t) => t && t.name && t.description);

    if (validTools.length === 0) {
      throw new Error('No valid tools with name and description found in generation plan');
    }

    const toolCount = validTools.length;
    const toolsList = validTools.map((t) => `- ${t.name}: ${t.description}`).join('\n');

    // Build constraint warning if user specified limits (Issue #137)
    let constraintWarning = '';
    if (state.requestedToolCount || state.requestedToolNames?.length || state.readOnlyOnly) {
      constraintWarning = `\n**⚠️ CRITICAL: USER TOOL CONSTRAINTS**\n`;
      if (state.requestedToolCount) {
        constraintWarning += `- User explicitly requested ${state.requestedToolCount} tools\n`;
      }
      if (state.requestedToolNames?.length) {
        constraintWarning += `- User specifically requested: ${state.requestedToolNames.join(', ')}\n`;
      }
      if (state.readOnlyOnly) {
        constraintWarning += `- User asked for READ-ONLY tools: implement NO create/update/delete/write behaviour\n`;
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

    this.logger.log(
      `Prompt prepared for ${toolCount} valid tools (user constraint: ${state.requestedToolCount || 'none'})`,
    );

    try {
      const response = await this.generateCode(prompt, 'refinement.generateMainFile');
      const code = this.stripCodeFence(response);

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
   * Normalises a loosely-shaped generated-code object into GeneratedCode.
   *
   * @param generated - Generated code from a previous refinement iteration
   * @returns GeneratedCode structure
   */
  private convertToGeneratedCode(generated: any): GeneratedCode {
    // Tolerate a files[] array shape as well as the flat mainFile shape
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

    // Every generated server needs a Dockerfile: container-registry.service.ts
    // runs `docker build` directly against the on-disk server directory when
    // deploying to cloud hosting, and nothing else in the pipeline emits one.
    // Don't clobber a Dockerfile the generation step may have already produced.
    if (!supportingFiles['Dockerfile']) {
      supportingFiles['Dockerfile'] = this.generateDockerfile();
    }
    if (!supportingFiles['.dockerignore']) {
      supportingFiles['.dockerignore'] = this.generateDockerignore();
    }

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
          // Current major as of 2026-07 (verified against npm registry: latest
          // is 1.30.0). The reference implementation below uses only APIs
          // (Server + setRequestHandler, StdioServerTransport with no
          // arguments, ListToolsRequestSchema/CallToolRequestSchema, zod v3
          // .issues) confirmed unchanged across the 1.x line.
          '@modelcontextprotocol/sdk': '^1.0.0',
          zod: '^3.23.0',
          axios: '^1.7.0',
        },
        devDependencies: {
          '@types/node': '^20.0.0',
          typescript: '^5.0.0',
        },
      },
      null,
      2,
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
      2,
    );
  }

  /**
   * Generate Dockerfile
   *
   * Creates a simple multi-stage Dockerfile so generated MCP servers are
   * container-buildable out of the box. container-registry.service.ts runs
   * `docker build` directly against the generated server directory when
   * deploying to cloud hosting, so every generated server needs one of these.
   *
   * @returns Dockerfile contents
   */
  private generateDockerfile(): string {
    return `# Auto-generated by MCP Everything - simple Node 20 multi-stage build
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
# npm install, not npm ci: generated servers ship without a package-lock.json
RUN npm install --ignore-scripts --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
RUN addgroup -g 1001 -S mcp && adduser -S mcp -u 1001
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER mcp
CMD ["node", "dist/index.js"]
`;
  }

  /**
   * Generate .dockerignore
   *
   * @returns .dockerignore contents
   */
  private generateDockerignore(): string {
    return `node_modules
dist
.git
*.log
.env
`;
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
    generatedCode: GeneratedCode,
  ): Promise<FailureAnalysis> {
    const failures = testResults.results.filter((r) => !r.success);

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
${failures
  .map(
    (f, i) => `
${i + 1}. Tool: ${f.toolName}
   - Error: ${f.error}
   - MCP Compliant: ${f.mcpCompliant}
   - Execution Time: ${f.executionTime}ms
`,
  )
  .join('\n')}

**Task**: Analyze root causes and provide specific fixes.

**Failure Categories**:
1. **Syntax**: TypeScript compilation errors, import issues
2. **Runtime**: Exceptions during execution, undefined variables
3. **MCP Protocol**: Invalid JSON-RPC responses, missing fields
4. **Logic**: Incorrect implementation, wrong outputs
5. **Timeout**: Tools taking >5 seconds

**Provide**:
- failureCount
- categories: [{ type: syntax|runtime|mcp_protocol|logic|timeout, count }]
- rootCauses: specific descriptions of each root cause
- fixes: [{ toolName, issue, solution, priority: HIGH|MEDIUM|LOW, codeSnippet (optional) }]
- recommendation: overall strategy for fixing all issues

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
}`;

    try {
      const analysis: FailureAnalysis = await this.anthropic.completeStructured({
        prompt,
        schema: FailureAnalysisSchema,
        schemaName: 'FailureAnalysis',
        maxTokens: ANALYSIS_MAX_TOKENS,
        caller: 'refinement.analyzeFailures',
      });

      this.logger.log(
        `Failure analysis: ${analysis.rootCauses.length} root causes, ${analysis.fixes.length} fixes`,
      );

      return analysis;
    } catch (error) {
      this.logger.error(`Failure analysis failed: ${error.message}`);

      // Fallback: Basic analysis from test results
      return {
        failureCount: failures.length,
        categories: [{ type: 'runtime', count: failures.length }],
        rootCauses: failures.map((f) => f.error || 'Unknown error'),
        fixes: failures.map((f) => ({
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
    _plan: PipelineState['generationPlan'],
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
  .map(
    (f, i) => `
${i + 1}. **${f.toolName}** (${f.priority}):
   - Issue: ${f.issue}
   - Solution: ${f.solution}
   ${f.codeSnippet ? `- Example: ${f.codeSnippet}` : ''}
`,
  )
  .join('\n')}

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
      const response = await this.generateCode(prompt, 'refinement.refineCode');
      const refinedCode = this.stripCodeFence(response);

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

  // ---------------------------------------------------------------------------
  // Quality gate (salvaged from the retired McpGenerationService)
  // ---------------------------------------------------------------------------

  /**
   * Run the LLM-as-judge quality gate on code that already passed tool tests
   * and protocol validation.
   *
   * Docker tests prove the tools *run*; the judge catches what running cannot:
   * leftover TODO/placeholder bodies, truncated files, commentary before the
   * imports, tools present in the plan but missing from the implementation.
   *
   * Returns null when the gate is disabled or errored (never blocks a run).
   */
  private async runQualityGate(
    generatedCode: GeneratedCode,
    state: PipelineState,
  ): Promise<CodeQualityJudgement | null> {
    if (!this.qualityGateEnabled) {
      return null;
    }

    try {
      const judgement = await this.judgeCodeQuality(generatedCode, state);
      this.logger.log(
        `Quality gate: ${judgement.isValid ? 'PASSED' : 'FAILED'} ` +
          `(score ${judgement.score}, ${judgement.issues.length} issues)`,
      );
      return judgement;
    } catch (error) {
      this.logger.warn(`Quality gate error, treating as pass: ${error.message}`);
      return null;
    }
  }

  /**
   * Judge Code Quality
   *
   * Combines a real TypeScript compile check with an LLM judge that scores the
   * implementation against MCP protocol and completeness criteria.
   */
  private async judgeCodeQuality(
    generatedCode: GeneratedCode,
    state: PipelineState,
  ): Promise<CodeQualityJudgement> {
    const code = generatedCode.mainFile;
    const tsValidation = this.validateTypeScriptCompilation(code);

    const plannedTools =
      state.generationPlan?.toolsToGenerate || generatedCode.metadata.tools || [];
    const toolNames = plannedTools.map((t: any) => t.name).join(', ');
    const firstLine = code.split('\n')[0].trim();
    const hasServerConnect =
      code.includes('server.connect(transport)') || code.includes('await server.connect(');
    const hasTodos = /TODO|FIXME|placeholder/i.test(code);

    const prompt = `You are a strict code quality judge for TypeScript MCP servers.

**VALIDATION CRITERIA (ALL must pass):**

**1. File Structure (CRITICAL):**
- Code must start with TypeScript imports
- NO commentary text before imports
- NO markdown code blocks
- Complete file from imports to main() function

**2. TypeScript Syntax:**
- Valid, parseable TypeScript
- Proper import statements
- No syntax errors, no truncated file

**3. MCP Protocol Compliance:**
- Uses @modelcontextprotocol/sdk correctly
- Has a ListToolsRequestSchema handler
- Has a CallToolRequestSchema handler
- Returns { content: [{ type: 'text', text: '...' }] }
- Has an async main() with await server.connect(transport)

**4. Implementation Completeness:**
- ALL planned tools have real implementations
- NO TODO, FIXME or placeholder bodies
- No tool returns fabricated/stubbed data
- No incomplete code blocks, no file truncated mid-function

**5. Scope:**
- EXACTLY the planned tools are implemented - no extras

**Server**: ${generatedCode.metadata.serverName}
**Refinement iteration**: ${generatedCode.metadata.iteration}
**Planned tools (${plannedTools.length})**: ${toolNames}

**Pre-check results:**
- First line: "${firstLine}"
- Starts with import: ${firstLine.startsWith('import')}
- Has server.connect(transport): ${hasServerConnect}
- Contains TODO/FIXME/placeholder: ${hasTodos}
- TypeScript parses (syntax only): ${tsValidation.compiles}
- Syntax errors: ${tsValidation.errors.slice(0, 20).join('; ') || 'None'}

**Code to evaluate:**
\`\`\`typescript
${code}
\`\`\`

Be strict: if any criterion fails, \`isValid\` must be false. Score 0-100.
Each issue needs a category, the concrete problem, and an actionable fix.`;

    const judgement = await this.anthropic.completeStructured({
      prompt,
      schema: CodeQualityJudgementSchema,
      schemaName: 'CodeQualityJudgement',
      maxTokens: ANALYSIS_MAX_TOKENS,
      caller: 'refinement.judgeCodeQuality',
    });

    // A syntax error is objective - it overrides an optimistic judge.
    const compilationIssues: CodeQualityJudgement['issues'] = tsValidation.errors.map((error) => ({
      category: 'typescript' as const,
      message: error,
      suggestion: 'Fix the TypeScript syntax error',
    }));

    return {
      isValid: judgement.isValid && tsValidation.compiles,
      score: judgement.score,
      feedback: judgement.feedback,
      issues: [...compilationIssues, ...judgement.issues],
    };
  }

  /**
   * Validate TypeScript Syntax
   *
   * In-process syntactic check of the generated main file: catches truncated
   * files, unbalanced blocks, and prose accidentally emitted before the imports
   * - the failure modes that waste a full Docker build round-trip.
   *
   * Deliberately syntax-only. Full type checking needs the server's real
   * `node_modules` (`@modelcontextprotocol/sdk`, `zod`, lib.d.ts), which this
   * process does not have; the Docker build in McpTestingService runs `tsc`
   * against the installed dependencies and is the authority on type errors.
   */
  private validateTypeScriptCompilation(code: string): { compiles: boolean; errors: string[] } {
    try {
      const { diagnostics = [] } = ts.transpileModule(code, {
        reportDiagnostics: true,
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          esModuleInterop: true,
        },
      });

      const errors = diagnostics
        .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
        .map((diagnostic) => {
          const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
          const line =
            diagnostic.file && diagnostic.start !== undefined
              ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1
              : 0;
          return `Line ${line}: ${message}`;
        });

      return { compiles: errors.length === 0, errors };
    } catch (error) {
      return {
        compiles: false,
        errors: [`TypeScript parse error: ${error.message}`],
      };
    }
  }

  /** Translate a failed quality judgement into the refinement loop's currency. */
  private toFailureAnalysis(
    judgement: CodeQualityJudgement,
    generatedCode: GeneratedCode,
  ): FailureAnalysis {
    const serverTool = generatedCode.metadata.tools[0]?.name || 'server';

    return {
      failureCount: judgement.issues.length || 1,
      categories: [
        {
          type: judgement.issues.some((i) => i.category === 'typescript') ? 'syntax' : 'logic',
          count: judgement.issues.length || 1,
        },
      ],
      rootCauses: judgement.issues.length
        ? judgement.issues.map((i) => i.message)
        : [judgement.feedback],
      fixes: judgement.issues.map((issue) => ({
        toolName: issue.category === 'tool-implementation' ? serverTool : 'server',
        issue: issue.message,
        solution: issue.suggestion,
        priority: issue.category === 'code-quality' ? ('MEDIUM' as const) : ('HIGH' as const),
      })),
      recommendation:
        judgement.feedback ||
        'Address the quality issues found by the code judge without changing the tool set',
    };
  }
}
