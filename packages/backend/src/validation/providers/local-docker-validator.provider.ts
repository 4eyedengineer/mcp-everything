import { Injectable, Logger } from '@nestjs/common';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

import {
  McpTestingService,
  GeneratedCode,
  McpServerTestResult,
  TestProgressUpdate,
} from '../../testing/mcp-testing.service';
import {
  ValidationResult,
  ValidationOptions,
  ValidationProgressUpdate,
  ToolValidationResult,
  GeneratedCodeForValidation,
} from '../types/validation.types';

/**
 * Local Docker-based validator for MCP servers
 * Wraps McpTestingService to validate deployed servers
 */
@Injectable()
export class LocalDockerValidatorProvider {
  private readonly logger = new Logger(LocalDockerValidatorProvider.name);
  private readonly generatedServersDir: string;
  private progressCallbacks: Map<string, (update: ValidationProgressUpdate) => void> = new Map();

  constructor(private readonly mcpTestingService: McpTestingService) {
    this.generatedServersDir = join(process.cwd(), '../../generated-servers');
  }

  /**
   * Register progress callback for streaming updates
   */
  registerProgressCallback(
    validationId: string,
    callback: (update: ValidationProgressUpdate) => void,
  ): void {
    this.progressCallbacks.set(validationId, callback);
  }

  /**
   * Unregister progress callback
   */
  unregisterProgressCallback(validationId: string): void {
    this.progressCallbacks.delete(validationId);
  }

  /**
   * Validate an MCP server from the generated-servers directory
   */
  async validateFromFileSystem(
    conversationId: string,
    options: ValidationOptions = {},
  ): Promise<ValidationResult> {
    this.logger.log(`Starting validation for conversation: ${conversationId}`);

    // Load generated code from file system
    const generatedCode = await this.loadGeneratedCode(conversationId);
    if (!generatedCode) {
      return {
        buildSuccess: false,
        buildError: `No generated files found for conversation: ${conversationId}`,
        toolResults: [],
        errors: [`No generated files found for conversation: ${conversationId}`],
        source: 'local_docker',
      };
    }

    return this.validateGeneratedCode(generatedCode, options);
  }

  /**
   * Validate provided generated code
   */
  async validateGeneratedCode(
    code: GeneratedCodeForValidation,
    options: ValidationOptions = {},
  ): Promise<ValidationResult> {
    const validationId = `validation-${Date.now()}`;

    try {
      // Convert to McpTestingService format
      const generatedCode: GeneratedCode = {
        mainFile: code.mainFile,
        packageJson: code.packageJson,
        tsConfig: code.tsConfig || this.getDefaultTsConfig(),
        supportingFiles: code.supportingFiles,
        metadata: {
          tools: code.metadata.tools,
          iteration: 1,
          serverName: code.metadata.serverName,
        },
      };

      // Register progress forwarding
      this.mcpTestingService.registerProgressCallback(validationId, (update) => {
        this.forwardProgress(validationId, update);
      });

      // Run the test
      const result = await this.mcpTestingService.testMcpServer(generatedCode, {
        cpuLimit: options.cpuLimit || '0.5',
        memoryLimit: options.memoryLimit || '512m',
        timeout: options.timeout || 120,
        toolTimeout: options.toolTimeout || 10,
        networkMode: 'none',
        cleanup: true,
      });

      // Cleanup
      this.mcpTestingService.unregisterProgressCallback(validationId);

      // Convert result to ValidationResult
      return this.convertTestResult(result);
    } catch (error) {
      this.logger.error(`Validation failed: ${error.message}`);
      return {
        buildSuccess: false,
        buildError: error.message,
        toolResults: [],
        errors: [error.message],
        source: 'local_docker',
      };
    }
  }

  /**
   * Load generated code from file system
   */
  private async loadGeneratedCode(conversationId: string): Promise<GeneratedCodeForValidation | null> {
    const serverDir = join(this.generatedServersDir, conversationId);

    if (!existsSync(serverDir)) {
      this.logger.warn(`Server directory not found: ${serverDir}`);
      return null;
    }

    try {
      const files = this.readDirectory(serverDir);

      // Find main files
      const mainFile = files.find((f) => f.path === 'src/index.ts')?.content || '';
      const packageJson = files.find((f) => f.path === 'package.json')?.content || '';
      const tsConfig = files.find((f) => f.path === 'tsconfig.json')?.content;

      if (!mainFile || !packageJson) {
        this.logger.warn(`Missing main file or package.json in ${serverDir}`);
        return null;
      }

      // Build supporting files map
      const supportingFiles: Record<string, string> = {};
      for (const file of files) {
        if (
          file.path !== 'src/index.ts' &&
          file.path !== 'package.json' &&
          file.path !== 'tsconfig.json'
        ) {
          supportingFiles[file.path] = file.content;
        }
      }

      // Extract tools from main file (basic extraction)
      const tools = this.extractToolsFromSource(mainFile);

      // Get server name from package.json
      let serverName = 'mcp-server';
      try {
        const pkg = JSON.parse(packageJson);
        serverName = pkg.name || serverName;
      } catch {
        // Ignore parse error
      }

      return {
        mainFile,
        packageJson,
        tsConfig,
        supportingFiles,
        metadata: {
          tools,
          serverName,
        },
      };
    } catch (error) {
      this.logger.error(`Failed to load generated code: ${error.message}`);
      return null;
    }
  }

  /**
   * Read directory recursively
   */
  private readDirectory(dir: string, basePath: string = ''): Array<{ path: string; content: string }> {
    const files: Array<{ path: string; content: string }> = [];
    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        if (!['node_modules', '.git', 'dist'].includes(entry.name)) {
          files.push(...this.readDirectory(fullPath, relativePath));
        }
      } else if (entry.isFile()) {
        try {
          const content = readFileSync(fullPath, 'utf-8');
          files.push({ path: relativePath, content });
        } catch (error) {
          this.logger.warn(`Failed to read file ${fullPath}: ${error.message}`);
        }
      }
    }

    return files;
  }

  /**
   * Extract tools from source code (basic pattern matching)
   */
  private extractToolsFromSource(source: string): Array<{ name: string; inputSchema: any; description: string }> {
    const tools: Array<{ name: string; inputSchema: any; description: string }> = [];

    // Match server.tool() calls with tool definitions
    const toolPattern = /server\.tool\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*['"`]([^'"`]*)['"`]\s*,\s*(\{[^}]*\})/g;
    let match;

    while ((match = toolPattern.exec(source)) !== null) {
      const [, name, description, schemaStr] = match;
      let inputSchema = {};
      try {
        // Try to parse the schema (basic JSON-like parsing)
        inputSchema = JSON.parse(schemaStr.replace(/'/g, '"'));
      } catch {
        // If parsing fails, use empty schema
        inputSchema = { type: 'object', properties: {} };
      }

      tools.push({ name, description, inputSchema });
    }

    // If no tools found via pattern, return a default
    if (tools.length === 0) {
      this.logger.warn('No tools found in source via pattern matching');
    }

    return tools;
  }

  /**
   * Convert McpServerTestResult to ValidationResult
   */
  private convertTestResult(result: McpServerTestResult): ValidationResult {
    const toolResults: ToolValidationResult[] = result.results.map((r) => ({
      toolName: r.toolName,
      success: r.success,
      error: r.error,
      executionTime: r.executionTime,
      mcpCompliant: r.mcpCompliant,
      output: r.output,
    }));

    const errors: string[] = [];
    if (result.buildError) {
      errors.push(`Build error: ${result.buildError}`);
    }
    for (const r of result.results) {
      if (!r.success && r.error) {
        errors.push(`Tool ${r.toolName}: ${r.error}`);
      }
    }
    errors.push(...result.cleanupErrors);

    return {
      buildSuccess: result.buildSuccess,
      buildDuration: result.buildDuration,
      buildError: result.buildError,
      toolResults,
      errors: errors.length > 0 ? errors : undefined,
      source: 'local_docker',
      containerId: result.containerId,
      imageTag: result.imageTag,
    };
  }

  /**
   * Forward progress updates from McpTestingService
   */
  private forwardProgress(validationId: string, update: TestProgressUpdate): void {
    const callback = this.progressCallbacks.get(validationId);
    if (callback) {
      // Convert TestProgressUpdate to ValidationProgressUpdate
      const validationUpdate: ValidationProgressUpdate = {
        type: update.type as ValidationProgressUpdate['type'],
        message: update.message,
        phase: update.phase,
        progress: update.progress,
        toolName: update.toolName,
        toolIndex: update.toolIndex,
        totalTools: update.totalTools,
        timestamp: update.timestamp,
      };
      callback(validationUpdate);
    }
  }

  /**
   * Get default TypeScript config
   */
  private getDefaultTsConfig(): string {
    return JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        outDir: './dist',
        rootDir: './src',
      },
      include: ['src/**/*'],
    }, null, 2);
  }
}
