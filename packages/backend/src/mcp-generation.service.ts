import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import * as ts from 'typescript';
import Anthropic from '@anthropic-ai/sdk';
import { GitHubAnalysisService } from './github-analysis.service';
import { ToolDiscoveryService } from './tool-discovery.service';
import { RepositoryAnalysis } from './types/github-analysis.types';
import {
  McpTool,
  ToolDiscoveryResult,
  JsonSchema,
  JsonSchemaProperty,
  ToolExample,
} from './types/tool-discovery.types';

export interface GeneratedServer {
  serverName: string;
  conversationId: string;
  files: GeneratedFile[];
  metadata: ServerMetadata;
}

export interface GeneratedFile {
  path: string;
  content: string;
}

export interface ServerMetadata {
  githubUrl: string;
  description: string;
  generatedAt: string;
  tools: McpTool[];
  quality: QualityValidation;
}

export interface QualityValidation {
  passed: boolean;
  compiles: boolean;
  mcpCompliant: boolean;
  toolsImplemented: boolean;
  errors: string[];
  warnings: string[];
  regenerationCount: number;
}

export interface JudgeValidationResult {
  isValid: boolean;
  feedback: string;
  issues: ValidationIssue[];
  score: number;
}

export interface ValidationIssue {
  type: 'error' | 'warning';
  category: 'typescript' | 'mcp-protocol' | 'tool-implementation' | 'code-quality';
  message: string;
  suggestion: string;
}

@Injectable()
export class McpGenerationService {
  private readonly logger = new Logger(McpGenerationService.name);
  private readonly anthropic: Anthropic;
  private readonly outputDir: string;
  private readonly maxRegenerationAttempts = 3;

  constructor(
    private readonly configService: ConfigService,
    private readonly githubAnalysisService: GitHubAnalysisService,
    private readonly toolDiscoveryService: ToolDiscoveryService,
  ) {
    const apiKey = this.configService.get<string>('ANTHROPIC_API_KEY');
    if (!apiKey || apiKey === 'your-anthropic-api-key-here') {
      throw new Error('ANTHROPIC_API_KEY environment variable is required');
    }

    this.anthropic = new Anthropic({
      apiKey,
      timeout: 30000, // 30 second timeout for individual API calls
    });

    // Set output directory for generated servers
    this.outputDir = join(process.cwd(), '../../generated-servers');
    if (!existsSync(this.outputDir)) {
      mkdirSync(this.outputDir, { recursive: true });
    }
  }

  /**
   * Main orchestration method for generating MCP servers
   */
  async generateMCPServer(githubUrl: string, conversationId?: string): Promise<GeneratedServer> {
    const startTime = Date.now();
    this.logger.log(`Starting MCP server generation for: ${githubUrl}`);

    try {
      // Step 1: Analyze repository
      const analysis = await this.githubAnalysisService.analyzeRepository(githubUrl);
      this.logger.log('Repository analysis completed');

      // Step 2: Discover tools
      const toolDiscovery = await this.toolDiscoveryService.discoverTools(analysis);
      this.logger.log(`Discovered ${toolDiscovery.tools.length} tools`);

      // Step 3: Generate server code with iterative improvement
      const serverCode = await this.generateServerCodeWithValidation(analysis, toolDiscovery);
      this.logger.log('Server code generation completed');

      // Step 4: Generate tool implementations
      const toolImplementations = await this.generateToolImplementations(
        toolDiscovery.tools,
        analysis,
      );
      this.logger.log('Tool implementations generated');

      // Step 5: Package complete server
      const generatedServer = await this.packageServer(
        serverCode,
        toolImplementations,
        analysis,
        toolDiscovery,
        githubUrl,
        conversationId,
      );

      const totalTime = Date.now() - startTime;
      this.logger.log(`MCP server generation completed in ${totalTime}ms`);

      return generatedServer;
    } catch (error) {
      this.logger.error(`MCP server generation failed: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * Generate main server code with judge validation and iterative improvement
   */
  private async generateServerCodeWithValidation(
    analysis: RepositoryAnalysis,
    toolDiscovery: ToolDiscoveryResult,
  ): Promise<string> {
    let regenerationCount = 0;
    let currentCode: string;
    let validation: JudgeValidationResult;

    while (regenerationCount <= this.maxRegenerationAttempts) {
      this.logger.log(`Generating server code (attempt ${regenerationCount + 1})`);

      // Generate or regenerate code
      if (regenerationCount === 0) {
        currentCode = await this.generateServerCode(analysis, toolDiscovery.tools);
      } else {
        currentCode = await this.regenerateServerCode(
          currentCode,
          validation.feedback,
          analysis,
          toolDiscovery.tools,
        );
      }

      // Validate with judge LLM
      validation = await this.judgeCodeQuality(currentCode, analysis, toolDiscovery.tools);

      if (validation.isValid) {
        this.logger.log(
          `Server code validated successfully after ${regenerationCount + 1} attempts`,
        );
        return currentCode;
      }

      this.logger.warn(
        `Validation failed (attempt ${regenerationCount + 1}): ${validation.feedback}`,
      );
      regenerationCount++;
    }

    throw new Error(
      `Failed to generate valid server code after ${this.maxRegenerationAttempts} attempts`,
    );
  }

  /**
   * Generate main MCP server code using AI
   */
  private async generateServerCode(
    analysis: RepositoryAnalysis,
    tools: McpTool[],
  ): Promise<string> {
    const systemPrompt = this.buildSystemPrompt();
    const codePrompt = this.buildServerCodePrompt(analysis, tools);

    const response = await this.anthropic.messages.create({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 6000, // Increased for more complete code generation
      system: systemPrompt,
      messages: [{ role: 'user', content: codePrompt }],
    });

    const content = response.content[0];
    if (content.type !== 'text') {
      throw new Error('Unexpected response format from Anthropic');
    }

    // Extract code from response with improved parsing
    return this.extractTypeScriptCode(content.text);
  }

  /**
   * Regenerate server code based on judge feedback
   */
  private async regenerateServerCode(
    previousCode: string,
    feedback: string,
    analysis: RepositoryAnalysis,
    tools: McpTool[],
  ): Promise<string> {
    const systemPrompt = this.buildSystemPrompt();
    const regenerationPrompt = this.buildRegenerationPrompt(
      previousCode,
      feedback,
      analysis,
      tools,
    );

    const response = await this.anthropic.messages.create({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 6000, // Increased for more complete code generation
      system: systemPrompt,
      messages: [{ role: 'user', content: regenerationPrompt }],
    });

    const content = response.content[0];
    if (content.type !== 'text') {
      throw new Error('Unexpected response format from Anthropic');
    }

    // Extract code from response with improved parsing
    return this.extractTypeScriptCode(content.text);
  }

  /**
   * Generate implementations for each discovered tool
   */
  private async generateToolImplementations(
    tools: McpTool[],
    analysis: RepositoryAnalysis,
  ): Promise<Record<string, string>> {
    const implementations: Record<string, string> = {};

    for (const tool of tools) {
      this.logger.log(`Generating implementation for tool: ${tool.name}`);

      const systemPrompt = this.buildToolImplementationSystemPrompt();
      const toolPrompt = this.buildToolImplementationPrompt(tool, analysis);

      const response = await this.anthropic.messages.create({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 2000,
        system: systemPrompt,
        messages: [{ role: 'user', content: toolPrompt }],
      });

      const content = response.content[0];
      if (content.type !== 'text') {
        throw new Error('Unexpected response format from Anthropic');
      }

      // Extract implementation code - should be function body only
      let implementation = content.text;

      // Remove markdown code blocks if present
      const codeMatch = content.text.match(/```(?:typescript|ts)?\n([\s\S]*?)\n```/);
      if (codeMatch) {
        implementation = codeMatch[1];
      }

      // Clean up common issues in implementation code
      implementation = implementation.trim();

      // Remove any function declaration if AI included it despite instructions
      implementation = implementation.replace(
        /^async\s+function\s+\w+\([^)]*\)\s*:\s*[^{]*\{\s*/m,
        '',
      );
      implementation = implementation.replace(/\}$/, '');

      // Ensure it starts with try/catch or actual implementation
      if (!implementation.includes('try {') && !implementation.includes('return {')) {
        implementation = `try {\n  ${implementation}\n} catch (error) {\n  throw new McpError(ErrorCode.InternalError, \`Error in ${tool.name}: \${error.message}\`);\n}`;
      }

      implementations[tool.name] = implementation;
    }

    return implementations;
  }

  /**
   * Judge LLM validates generated code quality
   */
  private async judgeCodeQuality(
    code: string,
    analysis: RepositoryAnalysis,
    tools: McpTool[],
  ): Promise<JudgeValidationResult> {
    // First, validate TypeScript compilation
    const tsValidation = this.validateTypeScriptCompilation(code);

    // Then, validate with AI judge
    const systemPrompt = this.buildJudgeSystemPrompt();
    const judgePrompt = this.buildJudgePrompt(code, analysis, tools, tsValidation);

    const response = await this.anthropic.messages.create({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 1500,
      system: systemPrompt,
      messages: [{ role: 'user', content: judgePrompt }],
    });

    const content = response.content[0];
    if (content.type !== 'text') {
      throw new Error('Unexpected response format from Anthropic');
    }

    // Parse judge response
    return this.parseJudgeResponse(content.text, tsValidation);
  }

  /**
   * Validate TypeScript compilation
   */
  private validateTypeScriptCompilation(code: string): { compiles: boolean; errors: string[] } {
    try {
      const compilerOptions: ts.CompilerOptions = {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.NodeJs,
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true,
        noEmit: true,
      };

      const sourceFile = ts.createSourceFile('index.ts', code, ts.ScriptTarget.ES2022, true);

      const compilerHost: ts.CompilerHost = {
        getSourceFile: (fileName) => (fileName === 'index.ts' ? sourceFile : undefined),
        writeFile: () => {},
        getCurrentDirectory: () => '',
        getDirectories: () => [],
        fileExists: () => true,
        readFile: () => '',
        getCanonicalFileName: (fileName) => fileName,
        useCaseSensitiveFileNames: () => true,
        getNewLine: () => '\n',
        getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
        resolveModuleNames: () => undefined,
      };

      const program = ts.createProgram(['index.ts'], compilerOptions, compilerHost);

      const diagnostics = ts.getPreEmitDiagnostics(program);
      const errors = diagnostics.map((diagnostic) => {
        const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
        const line =
          diagnostic.file && diagnostic.start
            ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1
            : 0;
        return `Line ${line}: ${message}`;
      });

      return {
        compiles: errors.length === 0,
        errors,
      };
    } catch (error) {
      return {
        compiles: false,
        errors: [`TypeScript compilation error: ${error.message}`],
      };
    }
  }

  /**
   * Package complete MCP server with all files
   */
  private async packageServer(
    serverCode: string,
    toolImplementations: Record<string, string>,
    analysis: RepositoryAnalysis,
    toolDiscovery: ToolDiscoveryResult,
    githubUrl: string,
    conversationId?: string,
  ): Promise<GeneratedServer> {
    const serverName = `${analysis.metadata.name}-mcp-server`;
    const id = conversationId || `gen-${Date.now()}`;
    const serverDir = join(this.outputDir, id);

    // Create server directory
    if (!existsSync(serverDir)) {
      mkdirSync(serverDir, { recursive: true });
    }

    // Generate all files
    const files: GeneratedFile[] = [];

    // Main server file
    const mainServerCode = this.combineServerCodeWithTools(
      serverCode,
      toolImplementations,
      toolDiscovery.tools,
    );
    files.push({
      path: 'src/index.ts',
      content: mainServerCode,
    });

    // Package.json
    files.push({
      path: 'package.json',
      content: this.generatePackageJson(serverName, analysis),
    });

    // TypeScript config
    files.push({
      path: 'tsconfig.json',
      content: this.generateTsConfig(),
    });

    // README
    files.push({
      path: 'README.md',
      content: this.generateReadme(serverName, analysis, toolDiscovery.tools, githubUrl),
    });

    // Write files to disk
    for (const file of files) {
      const filePath = join(serverDir, file.path);
      const fileDir = dirname(filePath);

      if (!existsSync(fileDir)) {
        mkdirSync(fileDir, { recursive: true });
      }

      writeFileSync(filePath, file.content);
    }

    // Final validation
    const finalValidation = await this.validateGeneratedServer(serverDir, toolDiscovery.tools);

    this.logger.log(`Generated server packaged at: ${serverDir}`);

    return {
      serverName,
      conversationId: id,
      files,
      metadata: {
        githubUrl,
        description:
          analysis.metadata.description || `MCP Server for ${analysis.metadata.fullName}`,
        generatedAt: new Date().toISOString(),
        tools: toolDiscovery.tools,
        quality: finalValidation,
      },
    };
  }

  /**
   * Combine server code with tool implementations
   */
  private combineServerCodeWithTools(
    serverCode: string,
    toolImplementations: Record<string, string>,
    tools: McpTool[],
  ): string {
    // Since the new prompts generate complete code with implementations,
    // we primarily need to validate and potentially inject any missing implementations
    let combinedCode = serverCode;

    // Check if implementations are missing and inject them
    for (const tool of tools) {
      const functionName = `${tool.name}Implementation`;

      // If the function is missing from the server code, add it
      if (!combinedCode.includes(functionName)) {
        const implementation =
          toolImplementations[tool.name] ||
          `try {\n    return { content: [{ type: "text", text: "Implementation for ${tool.name} not found" }] };\n  } catch (error) {\n    throw new McpError(ErrorCode.InternalError, \`Error in ${tool.name}: \${error.message}\`);\n  }`;

        // Insert function before the server setup
        const serverIndex = combinedCode.indexOf('const server = new Server(');
        if (serverIndex !== -1) {
          const functionDef = `\nasync function ${functionName}(args: any): Promise<{ content: [{ type: "text", text: string }] }> {\n  ${implementation}\n}\n`;
          combinedCode =
            combinedCode.slice(0, serverIndex) + functionDef + combinedCode.slice(serverIndex);
        }
      }
    }

    return combinedCode;
  }

  /**
   * Validate final generated server
   */
  private async validateGeneratedServer(
    serverDir: string,
    tools: McpTool[],
  ): Promise<QualityValidation> {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check if all required files exist
    const requiredFiles = ['src/index.ts', 'package.json', 'tsconfig.json'];
    for (const file of requiredFiles) {
      if (!existsSync(join(serverDir, file))) {
        errors.push(`Missing required file: ${file}`);
      }
    }

    // Additional validations can be added here

    return {
      passed: errors.length === 0,
      compiles: true, // TODO: Add actual compilation check
      mcpCompliant: true, // TODO: Add MCP protocol validation
      toolsImplemented: true, // TODO: Verify all tools are implemented
      errors,
      warnings,
      regenerationCount: 0,
    };
  }

  // Helper methods for generating various files

  private generatePackageJson(serverName: string, analysis: RepositoryAnalysis): string {
    return JSON.stringify(
      {
        name: serverName,
        version: '0.1.0',
        description:
          analysis.metadata.description || `MCP Server for ${analysis.metadata.fullName}`,
        type: 'module',
        main: 'dist/index.js',
        scripts: {
          build: 'tsc',
          start: 'node dist/index.js',
          dev: 'tsc --watch',
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
      2,
    );
  }

  private generateTsConfig(): string {
    return JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'node',
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
          forceConsistentCasingInFileNames: true,
          outDir: './dist',
          rootDir: './src',
        },
        include: ['src/**/*'],
        exclude: ['node_modules', 'dist'],
      },
      null,
      2,
    );
  }

  /**
   * Generate comprehensive README.md for MCP server
   * Implements GitHub Issue #5 - comprehensive documentation
   */
  private generateReadme(
    serverName: string,
    analysis: RepositoryAnalysis,
    tools: McpTool[],
    githubUrl: string,
  ): string {
    const sections: string[] = [];

    // Header section
    sections.push(this.generateReadmeHeader(serverName, analysis));

    // Description section
    sections.push(this.generateDescriptionSection(analysis, githubUrl));

    // Quick start tools overview
    sections.push(this.generateToolsOverview(tools));

    // Installation section
    sections.push(this.generateInstallationSection());

    // Usage section
    sections.push(this.generateUsageSection());

    // Claude Desktop integration
    sections.push(this.generateClaudeDesktopSection(serverName));

    // Environment variables section
    sections.push(this.generateEnvironmentVariablesSection(tools));

    // Detailed tool documentation
    sections.push(this.generateDetailedToolDocs(tools));

    // Testing section
    sections.push(this.generateTestingSection());

    // Troubleshooting section
    sections.push(this.generateTroubleshootingSection());

    // Footer
    sections.push(this.generateReadmeFooter());

    return sections.filter(Boolean).join('\n\n');
  }

  /**
   * Generate README header with title and badge
   */
  private generateReadmeHeader(serverName: string, analysis: RepositoryAnalysis): string {
    return `# ${serverName}

> Generated by [MCP Everything](https://github.com/4eyedengineer/mcp-everything)

${analysis.metadata.description || `MCP Server for ${analysis.metadata.fullName}`}`;
  }

  /**
   * Generate description section with repository details
   */
  private generateDescriptionSection(analysis: RepositoryAnalysis, githubUrl: string): string {
    const techStack = analysis.techStack;
    const languages = techStack?.languages?.length ? techStack.languages.join(', ') : 'Not detected';
    const frameworks = techStack?.frameworks?.length ? techStack.frameworks.join(', ') : 'None detected';

    return `## Description

This MCP server was automatically generated from the repository **${analysis.metadata.fullName}**.

| Property | Value |
|----------|-------|
| **Source Repository** | [${analysis.metadata.fullName}](${githubUrl}) |
| **Primary Language** | ${analysis.metadata.language || 'Unknown'} |
| **Languages** | ${languages} |
| **Frameworks** | ${frameworks} |`;
  }

  /**
   * Generate quick overview of available tools
   */
  private generateToolsOverview(tools: McpTool[]): string {
    if (!tools.length) {
      return '## Tools\n\nNo tools available.';
    }

    const toolsList = tools
      .map((tool) => `- **${tool.name}**: ${tool.description}`)
      .join('\n');

    return `## Tools

This server provides ${tools.length} tool${tools.length === 1 ? '' : 's'}:

${toolsList}`;
  }

  /**
   * Generate installation instructions
   */
  private generateInstallationSection(): string {
    return `## Installation

\`\`\`bash
# Clone or download the server files
# Then install dependencies
npm install

# Build the TypeScript source
npm run build
\`\`\``;
  }

  /**
   * Generate usage instructions
   */
  private generateUsageSection(): string {
    return `## Usage

\`\`\`bash
# Start the MCP server
npm start
\`\`\`

The server communicates via stdio and is designed to be used with MCP-compatible clients.`;
  }

  /**
   * Generate Claude Desktop integration section
   */
  private generateClaudeDesktopSection(serverName: string): string {
    const configName = serverName.toLowerCase().replace(/[^a-z0-9-]/g, '-');

    return `## Claude Desktop Integration

To use this MCP server with Claude Desktop, add the following to your Claude Desktop configuration file:

**macOS**: \`~/Library/Application Support/Claude/claude_desktop_config.json\`
**Windows**: \`%APPDATA%\\Claude\\claude_desktop_config.json\`

\`\`\`json
{
  "mcpServers": {
    "${configName}": {
      "command": "node",
      "args": ["/absolute/path/to/${serverName}/dist/index.js"],
      "env": {
        // Add any required environment variables here
      }
    }
  }
}
\`\`\`

**Important**: Replace \`/absolute/path/to/${serverName}\` with the actual path to this server on your system.

After updating the configuration, restart Claude Desktop for the changes to take effect.`;
  }

  /**
   * Generate environment variables section from tool hints
   */
  private generateEnvironmentVariablesSection(tools: McpTool[]): string {
    const envVars = new Set<string>();

    // Extract potential environment variables from tool dependencies and hints
    for (const tool of tools) {
      const hints = tool.implementationHints;
      if (hints?.requiredData) {
        for (const data of hints.requiredData) {
          // Look for common patterns suggesting env vars
          if (data.toLowerCase().includes('api key') || data.toLowerCase().includes('api_key')) {
            envVars.add('API_KEY');
          }
          if (data.toLowerCase().includes('token')) {
            envVars.add('AUTH_TOKEN');
          }
          if (data.toLowerCase().includes('secret')) {
            envVars.add('API_SECRET');
          }
        }
      }
    }

    if (envVars.size === 0) {
      return `## Environment Variables

This server does not require any environment variables by default.

If your use case requires API keys or other credentials, you can configure them in your Claude Desktop config:

\`\`\`json
{
  "env": {
    "EXAMPLE_API_KEY": "your-api-key-here"
  }
}
\`\`\``;
    }

    const envList = Array.from(envVars)
      .map((v) => `| \`${v}\` | Required | Your ${v.toLowerCase().replace(/_/g, ' ')} |`)
      .join('\n');

    return `## Environment Variables

The following environment variables may be required:

| Variable | Required | Description |
|----------|----------|-------------|
${envList}

Create a \`.env\` file or configure these in your Claude Desktop config:

\`\`\`bash
# .env file
${Array.from(envVars).map((v) => `${v}=your-value-here`).join('\n')}
\`\`\``;
  }

  /**
   * Generate detailed documentation for each tool
   */
  private generateDetailedToolDocs(tools: McpTool[]): string {
    if (!tools.length) {
      return '';
    }

    const toolDocs = tools.map((tool) => this.generateSingleToolDoc(tool)).join('\n\n---\n\n');

    return `## Tool Documentation

${toolDocs}`;
  }

  /**
   * Generate documentation for a single tool
   */
  private generateSingleToolDoc(tool: McpTool): string {
    const sections: string[] = [];

    // Tool header
    sections.push(`### ${tool.name}`);
    sections.push(`**Category:** ${tool.category || 'general'}`);
    sections.push('');
    sections.push(tool.description);

    // Input parameters
    if (tool.inputSchema?.properties) {
      sections.push('');
      sections.push('#### Parameters');
      sections.push('');
      sections.push(this.formatInputSchema(tool.inputSchema));
    }

    // Examples
    if (tool.implementationHints?.examples?.length) {
      sections.push('');
      sections.push('#### Examples');
      sections.push('');
      sections.push(this.formatToolExamples(tool.implementationHints.examples));
    }

    // Additional info
    const hints = tool.implementationHints;
    if (hints) {
      sections.push('');
      sections.push('#### Details');
      sections.push('');
      sections.push(`- **Output Format:** ${hints.outputFormat || 'text'}`);
      sections.push(`- **Complexity:** ${hints.complexity || 'medium'}`);

      if (hints.errorHandling?.length) {
        sections.push(`- **Possible Errors:** ${hints.errorHandling.join(', ')}`);
      }
    }

    return sections.join('\n');
  }

  /**
   * Format input schema as markdown table
   */
  private formatInputSchema(schema: JsonSchema): string {
    if (!schema.properties || Object.keys(schema.properties).length === 0) {
      return 'This tool takes no parameters.';
    }

    const required = schema.required || [];
    const rows = Object.entries(schema.properties).map(([name, prop]) => {
      const property = prop as JsonSchemaProperty;
      const isRequired = required.includes(name) ? 'Yes' : 'No';
      const type = property.type || 'any';
      const description = property.description || '-';
      const defaultVal = property.default !== undefined ? `Default: \`${JSON.stringify(property.default)}\`` : '';
      const enumVal = property.enum ? `Options: ${property.enum.map(e => `\`${e}\``).join(', ')}` : '';
      const extra = [defaultVal, enumVal].filter(Boolean).join('. ');

      return `| \`${name}\` | ${type} | ${isRequired} | ${description}${extra ? ` ${extra}` : ''} |`;
    });

    return `| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
${rows.join('\n')}`;
  }

  /**
   * Format tool examples as markdown
   */
  private formatToolExamples(examples: ToolExample[]): string {
    return examples
      .map((example, index) => {
        const lines: string[] = [];
        lines.push(`**Example ${index + 1}:** ${example.description}`);
        lines.push('');
        lines.push('Input:');
        lines.push('```json');
        lines.push(JSON.stringify(example.input, null, 2));
        lines.push('```');
        if (example.expectedOutput) {
          lines.push('');
          lines.push('Expected Output:');
          lines.push('```');
          lines.push(example.expectedOutput);
          lines.push('```');
        }
        return lines.join('\n');
      })
      .join('\n\n');
  }

  /**
   * Generate testing section
   */
  private generateTestingSection(): string {
    return `## Testing

\`\`\`bash
# Run tests (if available)
npm test
\`\`\`

You can also test the server manually using the MCP Inspector or by connecting it to Claude Desktop.`;
  }

  /**
   * Generate troubleshooting section
   */
  private generateTroubleshootingSection(): string {
    return `## Troubleshooting

### Common Issues

**Server not starting**
- Ensure all dependencies are installed: \`npm install\`
- Ensure the project is built: \`npm run build\`
- Check that Node.js version is 18 or higher

**Claude Desktop not detecting the server**
- Verify the path in your config file is correct and absolute
- Restart Claude Desktop after config changes
- Check Claude Desktop logs for error messages

**Tool execution errors**
- Verify any required environment variables are set
- Check that API keys/tokens are valid
- Review the server logs for detailed error messages

### Getting Help

- [MCP Protocol Documentation](https://modelcontextprotocol.io/)
- [MCP Everything Issues](https://github.com/4eyedengineer/mcp-everything/issues)`;
  }

  /**
   * Generate README footer
   */
  private generateReadmeFooter(): string {
    return `## License

MIT

---

*Generated at: ${new Date().toISOString()}*

*This MCP server was automatically generated by [MCP Everything](https://github.com/4eyedengineer/mcp-everything).*`;
  }

  /**
   * Extract TypeScript code from AI response, handling various formatting issues
   */
  private extractTypeScriptCode(text: string): string {
    let extractedCode = text;

    // Remove markdown code blocks if present
    const codeMatch = text.match(/```(?:typescript|ts)?\n([\s\S]*?)\n```/);
    if (codeMatch) {
      extractedCode = codeMatch[1];
    }

    // Remove any explanatory text before imports
    const lines = extractedCode.split('\n');
    let startIndex = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('import ') || (line.startsWith('//') && line.includes('import'))) {
        startIndex = i;
        break;
      }
    }

    // If no import found, keep original
    if (startIndex > 0) {
      extractedCode = lines.slice(startIndex).join('\n');
    }

    // Clean up the code
    extractedCode = extractedCode.trim();

    // Validate basic structure for main server files
    if (extractedCode.includes('import { Server }')) {
      if (!extractedCode.includes('server.run()')) {
        this.logger.warn('Generated server code missing server.run() call');
      }
      if (!extractedCode.includes('setRequestHandler')) {
        this.logger.warn('Generated server code missing request handlers');
      }
    }

    return extractedCode;
  }

  // AI Prompt building methods

  private generateExampleImplementation(tool: McpTool): string {
    return `
async function ${tool.name}Implementation(args: any): Promise<{ content: [{ type: "text", text: string }] }> {
  try {
    // Example implementation for ${tool.name}
    // Args received: ${JSON.stringify(tool.inputSchema)}

    const result = \`Implementation for ${tool.name} with args: \${JSON.stringify(args)}\`;

    return {
      content: [{
        type: "text",
        text: result
      }]
    };
  } catch (error) {
    throw new McpError(
      ErrorCode.InternalError,
      \`Error in ${tool.name}: \${error.message}\`
    );
  }
}`;
  }

  private buildSystemPrompt(): string {
    return `You are an expert TypeScript developer specializing in Model Context Protocol (MCP) servers.

**CRITICAL: You MUST generate ONLY valid TypeScript code that compiles without errors.**

**OUTPUT FORMAT REQUIREMENTS:**
1. Start immediately with TypeScript imports - NO commentary, explanations, or markdown
2. Use ONLY the @modelcontextprotocol/sdk package
3. End with server.run() call
4. NO TODO comments, placeholders, or incomplete code
5. Every function must be fully implemented

**REQUIRED STRUCTURE:**
\`\`\`typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// Tool implementations here

const server = new Server(
  {
    name: "server-name",
    version: "0.1.0"
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

// Handlers here

server.run();
\`\`\`

**VALIDATION CHECKLIST (verify before responding):**
- [ ] Code starts with imports, no explanatory text
- [ ] All imports use exact paths from @modelcontextprotocol/sdk
- [ ] Every tool has complete implementation
- [ ] No TODO, FIXME, or placeholder comments
- [ ] TypeScript syntax is valid
- [ ] server.run() is called at the end

**NEVER:**
- Include markdown code blocks in output
- Add explanatory comments about what to implement
- Use placeholder functions
- Include any text before or after the code`;
  }

  private buildServerCodePrompt(analysis: RepositoryAnalysis, tools: McpTool[]): string {
    const toolsJson = JSON.stringify(tools, null, 2);
    const analysisContext = this.buildAnalysisContext(analysis);

    // Create concrete example with first tool for reference
    const exampleTool = tools[0];
    const exampleImplementation = this.generateExampleImplementation(exampleTool);

    return `Generate ONLY the TypeScript code for src/index.ts. NO explanations, NO markdown blocks.

**Repository Context:**
${analysisContext}

**Tools to implement:**
${toolsJson}

**EXACT TEMPLATE TO FOLLOW:**

\`\`\`typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode
} from '@modelcontextprotocol/sdk/types.js';

// Implement each tool as a function
${exampleImplementation}

const server = new Server(
  {
    name: "${analysis.metadata.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}-mcp-server",
    version: "0.1.0"
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      ${tools
        .map(
          (tool) => `{
        name: "${tool.name}",
        description: "${tool.description}",
        inputSchema: ${JSON.stringify(tool.inputSchema)}
      }`,
        )
        .join(',\n      ')}
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  switch (request.params.name) {
    ${tools
      .map(
        (tool) => `case "${tool.name}":
      return await ${tool.name}Implementation(request.params.arguments);`,
      )
      .join('\n    ')}
    default:
      throw new McpError(
        ErrorCode.MethodNotFound,
        \`Unknown tool: \${request.params.name}\`
      );
  }
});

const transport = new StdioServerTransport();
server.run();
\`\`\`

**CRITICAL:** Generate the complete TypeScript code following this exact structure. Replace the example with actual implementations for ALL ${tools.length} tools. Each tool function must return real data, not placeholders.`;
  }

  private buildToolImplementationSystemPrompt(): string {
    return `You are an expert TypeScript developer. Generate ONLY implementation logic for MCP server tools.

**CRITICAL REQUIREMENTS:**
- Generate ONLY the function body code (no function declaration)
- NO TODO, FIXME, or placeholder comments
- Return valid MCP response format: { content: [{ type: "text", text: string }] }
- Use actual data processing, not mock responses
- Include proper error handling
- Write production-ready code that compiles

**RETURN FORMAT:**
Return only the function body that goes inside:
\`\`\`typescript
async function toolImplementation(args: any): Promise<{ content: [{ type: "text", text: string }] }> {
  // YOUR CODE HERE
}
\`\`\``;
  }

  private buildToolImplementationPrompt(tool: McpTool, analysis: RepositoryAnalysis): string {
    const analysisContext = this.buildAnalysisContext(analysis);

    return `Generate ONLY the function body implementation for: **${tool.name}**

**Tool specification:**
- Name: ${tool.name}
- Description: ${tool.description}
- Input schema: ${JSON.stringify(tool.inputSchema)}

**Repository context:**
${analysisContext}

**Implementation requirements:**
- Primary action: ${tool.implementationHints.primaryAction}
- Required data: ${tool.implementationHints.requiredData.join(', ')}
- Output format: ${tool.implementationHints.outputFormat}

**EXAMPLE TEMPLATE:**
\`\`\`typescript
try {
  // Validate input arguments
  const { param1, param2 } = args || {};

  // Perform the actual tool action using repository context
  const result = \`Actual implementation result based on \${param1}\`;

  // Return in MCP format
  return {
    content: [{
      type: "text",
      text: result
    }]
  };
} catch (error) {
  throw new McpError(
    ErrorCode.InternalError,
    \`Error in ${tool.name}: \${error.message}\`
  );
}
\`\`\`

**Generate only the function body code (try/catch block) - NO function declaration, NO explanations.**`;
  }

  private buildJudgeSystemPrompt(): string {
    return `You are a strict code quality judge for TypeScript MCP servers.

**VALIDATION CRITERIA (ALL must pass):**

**1. File Structure (CRITICAL):**
- Code must start with TypeScript imports
- NO commentary text before imports
- NO markdown code blocks
- Complete file from import to server.run()

**2. TypeScript Syntax:**
- Valid TypeScript that compiles
- Proper import statements
- No syntax errors
- Correct function declarations

**3. MCP Protocol Compliance:**
- Uses @modelcontextprotocol/sdk correctly
- Has ListToolsRequestSchema handler
- Has CallToolRequestSchema handler
- Proper error handling with McpError
- server.run() called at end

**4. Implementation Completeness:**
- ALL tools have real implementations
- NO TODO, FIXME, or placeholder comments
- Functions return actual data
- No incomplete code blocks

**5. Common Failure Patterns to Reject:**
- Starts with explanatory text instead of imports
- Contains \"TODO: implement\" comments
- Has placeholder functions
- Missing critical imports
- Incomplete function implementations
- File ends abruptly mid-function

**RESPONSE FORMAT:**
VALID: [true/false]
SCORE: [0-100]
FEEDBACK: [specific issues found]
ISSUES: [actionable fixes needed]

**Be extremely strict. If ANY requirement fails, mark as invalid.**`;
  }

  private buildJudgePrompt(
    code: string,
    analysis: RepositoryAnalysis,
    tools: McpTool[],
    tsValidation: { compiles: boolean; errors: string[] },
  ): string {
    const toolNames = tools.map((t) => t.name).join(', ');
    const firstLine = code.split('\n')[0].trim();
    const hasServerRun = code.includes('server.run()');
    const hasTodos = /TODO|FIXME|placeholder|implement/i.test(code);

    return `**STRICT VALIDATION REQUIRED**

Code to evaluate:
\`\`\`typescript
${code}
\`\`\`

**Pre-check Results:**
- First line: "${firstLine}"
- Starts with import: ${firstLine.startsWith('import')}
- Has server.run(): ${hasServerRun}
- Contains TODOs/placeholders: ${hasTodos}
- TypeScript compiles: ${tsValidation.compiles}
- Compilation errors: ${tsValidation.errors.join('; ') || 'None'}

**Required tools to implement:** ${toolNames}

**CRITICAL VALIDATION CHECKS:**

1. **File Structure Issues:**
   - Does it start with explanatory text instead of imports?
   - Does it contain markdown code blocks?
   - Is the file truncated or incomplete?

2. **Implementation Issues:**
   - Are there TODO/FIXME/placeholder comments?
   - Are all ${tools.length} tools fully implemented?
   - Does each tool return real data?

3. **MCP Protocol Issues:**
   - Missing required imports?
   - No ListToolsRequestSchema handler?
   - No CallToolRequestSchema handler?
   - Missing server.run() call?

4. **TypeScript Issues:**
   - Syntax errors preventing compilation?
   - Incorrect import paths?
   - Type errors?

**If ANY of these issues exist, mark as INVALID.**

VALID: [true/false]
SCORE: [0-100]
FEEDBACK: [specific structural/implementation issues]
ISSUES: [exact problems to fix]`;
  }

  private buildRegenerationPrompt(
    previousCode: string,
    feedback: string,
    analysis: RepositoryAnalysis,
    tools: McpTool[],
  ): string {
    const analysisContext = this.buildAnalysisContext(analysis);

    return `**REGENERATION REQUIRED - CRITICAL FIXES NEEDED**

**Previous code FAILED validation with these issues:**
${feedback}

**Repository context:**
${analysisContext}

**CRITICAL: Generate ONLY the corrected TypeScript code. NO explanations.**

**REQUIRED STRUCTURE (follow exactly):**

\`\`\`
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode
} from '@modelcontextprotocol/sdk/types.js';

// Tool implementation functions
${tools
  .map(
    (tool) => `
async function ${tool.name}Implementation(args: any): Promise<{ content: [{ type: "text", text: string }] }> {
  // Real implementation for ${tool.name}
  // Must return actual data, not placeholders
  return {
    content: [{
      type: "text",
      text: "[Actual implementation result]"
    }]
  };
}`,
  )
  .join('')}

const server = new Server(
  {
    name: "${analysis.metadata.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}-mcp-server",
    version: "0.1.0"
  },
  {
    capabilities: { tools: {} }
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
${tools
  .map(
    (tool) => `    {
      name: "${tool.name}",
      description: "${tool.description}",
      inputSchema: ${JSON.stringify(tool.inputSchema)}
    }`,
  )
  .join(',\n')}
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  switch (request.params.name) {
${tools
  .map(
    (tool) => `    case "${tool.name}":
      return await ${tool.name}Implementation(request.params.arguments);`,
  )
  .join('\n')}
    default:
      throw new McpError(ErrorCode.MethodNotFound, \`Unknown tool: \${request.params.name}\`);
  }
});

server.run();
\`\`\`

**Generate the complete corrected code following this exact structure. Address ALL validation issues identified.**`;
  }

  private buildAnalysisContext(analysis: RepositoryAnalysis): string {
    return `Repository: ${analysis.metadata.fullName}
Description: ${analysis.metadata.description || 'No description'}
Language: ${analysis.metadata.language || 'Unknown'}
Tech Stack: ${analysis.techStack.languages.join(', ')}
Frameworks: ${analysis.techStack.frameworks.join(', ')}
Features: ${analysis.features.features.join(', ')}`;
  }

  private parseJudgeResponse(
    response: string,
    tsValidation: { compiles: boolean; errors: string[] },
  ): JudgeValidationResult {
    try {
      // Try to parse as JSON first
      const jsonResponse = JSON.parse(response);

      const issues: ValidationIssue[] = [];

      // Add TypeScript compilation issues
      if (!tsValidation.compiles) {
        tsValidation.errors.forEach((error) => {
          issues.push({
            type: 'error',
            category: 'typescript',
            message: error,
            suggestion: 'Fix TypeScript compilation error',
          });
        });
      }

      // Add issues from JSON response
      if (jsonResponse.issues && Array.isArray(jsonResponse.issues)) {
        jsonResponse.issues.forEach((issue: string) => {
          issues.push({
            type: 'error',
            category: 'code-quality',
            message: issue,
            suggestion: 'Address validation issue',
          });
        });
      }

      return {
        isValid: jsonResponse.isValid && tsValidation.compiles,
        feedback: jsonResponse.feedback || 'No feedback provided',
        issues,
        score: jsonResponse.score || 0,
      };
    } catch (error) {
      this.logger.warn(`Failed to parse judge JSON response: ${error.message}`);

      // Fallback parsing for non-JSON responses
      const validMatch = response.match(/VALID:\s*(true|false)/i);
      const scoreMatch = response.match(/SCORE:\s*(\d+)/);
      const feedbackMatch = response.match(/FEEDBACK:\s*(.*?)(?=ISSUES:|$)/s);

      const isValid = validMatch ? validMatch[1].toLowerCase() === 'true' : false;
      const score = scoreMatch ? parseInt(scoreMatch[1]) : 0;
      const feedback = feedbackMatch ? feedbackMatch[1].trim() : response.substring(0, 200);

      const issues: ValidationIssue[] = [];
      if (!tsValidation.compiles) {
        tsValidation.errors.forEach((error) => {
          issues.push({
            type: 'error',
            category: 'typescript',
            message: error,
            suggestion: 'Fix TypeScript compilation error',
          });
        });
      }

      return {
        isValid: isValid && tsValidation.compiles,
        feedback,
        issues,
        score,
      };
    }
  }
}
