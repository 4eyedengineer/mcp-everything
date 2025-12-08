import { Injectable, Logger } from '@nestjs/common';
import { spawn, ChildProcess } from 'child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import * as os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { McpSchemaValidator } from './mcp-schema-validator';

/**
 * MCP Protocol version to validate against
 */
const MCP_PROTOCOL_VERSION = '2024-11-05';

/**
 * Individual validation check result
 */
export interface ValidationCheck {
  name: string;
  passed: boolean;
  message: string;
  details?: any;
  duration?: number;
}

/**
 * Complete protocol validation result
 */
export interface McpProtocolValidationResult {
  valid: boolean;
  checks: ValidationCheck[];
  protocolVersion: string;
  serverInfo?: {
    name: string;
    version: string;
  };
  toolCount?: number;
  resourceCount?: number;
  totalDuration: number;
  errors: string[];
}

/**
 * MCP JSON-RPC Message
 */
interface McpMessage {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: any;
}

/**
 * MCP JSON-RPC Response
 */
interface McpResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

/**
 * Server process info
 */
interface ServerProcessInfo {
  process: ChildProcess;
  serverDir: string;
  pendingResponses: Map<string | number, { resolve: Function; reject: Function }>;
  buffer: string;
  stderrBuffer: string;
}

/**
 * Generated code structure for validation
 */
export interface GeneratedCodeForProtocolValidation {
  mainFile: string;
  packageJson: string;
  tsConfig?: string;
  supportingFiles?: Record<string, string>;
  metadata: {
    tools: Array<{ name: string; inputSchema: any; description: string }>;
    serverName: string;
  };
}

/**
 * MCP Protocol Validator Service
 *
 * Validates generated MCP servers against the MCP protocol specification.
 * Ensures compliance with:
 * - Initialize handshake
 * - Tool listing and schema validation
 * - Tool execution responses
 * - Resource listing (if applicable)
 *
 * Used by the generation service to verify servers before packaging
 * and by the refinement loop to determine if regeneration is needed.
 */
@Injectable()
export class McpProtocolValidatorService {
  private readonly logger = new Logger(McpProtocolValidatorService.name);
  private readonly tempBaseDir = join(os.tmpdir(), 'mcp-protocol-validation');
  private readonly schemaValidator = new McpSchemaValidator();
  private runningProcesses: Map<string, ServerProcessInfo> = new Map();

  constructor() {
    if (!existsSync(this.tempBaseDir)) {
      mkdirSync(this.tempBaseDir, { recursive: true });
    }
  }

  /**
   * Validate MCP server from generated code
   *
   * @param code - Generated server code structure
   * @returns Protocol validation result
   */
  async validateServer(code: GeneratedCodeForProtocolValidation): Promise<McpProtocolValidationResult> {
    const validationId = uuidv4();
    const startTime = Date.now();
    const results: ValidationCheck[] = [];
    const errors: string[] = [];
    let tempDir: string | null = null;

    this.logger.log(`[${validationId}] Starting MCP protocol validation`);

    try {
      // Step 1: Create temp directory and build server
      tempDir = await this.createTempServerDir(validationId, code);

      const buildResult = await this.buildServer(validationId, tempDir);
      results.push(buildResult);

      if (!buildResult.passed) {
        errors.push(`Build failed: ${buildResult.message}`);
        return this.createResult(false, results, errors, Date.now() - startTime);
      }

      // Step 2: Start server process
      await this.startServer(validationId, tempDir);

      // Step 3: Validate initialize handshake
      const initResult = await this.validateInitialize(validationId);
      results.push(initResult);

      if (!initResult.passed) {
        errors.push(`Initialize handshake failed: ${initResult.message}`);
        await this.stopServer(validationId);
        return this.createResult(false, results, errors, Date.now() - startTime, initResult.details?.serverInfo);
      }

      // Step 4: Validate tools/list
      const toolsListResult = await this.validateToolsList(validationId);
      results.push(toolsListResult);

      if (!toolsListResult.passed) {
        errors.push(`Tool listing validation failed: ${toolsListResult.message}`);
      }

      // Step 5: Validate tool schemas
      const tools = toolsListResult.details?.tools || [];
      const schemaResults = await this.validateToolSchemas(tools);
      results.push(...schemaResults);

      const invalidSchemas = schemaResults.filter(r => !r.passed);
      if (invalidSchemas.length > 0) {
        errors.push(`${invalidSchemas.length} tool(s) have invalid input schemas`);
      }

      // Step 6: Test tool execution (sample first 3 tools)
      const toolsToTest = tools.slice(0, 3);
      for (const tool of toolsToTest) {
        const execResult = await this.validateToolExecution(validationId, tool);
        results.push(execResult);

        if (!execResult.passed) {
          errors.push(`Tool "${tool.name}" execution validation failed: ${execResult.message}`);
        }
      }

      // Step 7: Validate resources/list (if server supports resources)
      const resourcesResult = await this.validateResourcesList(validationId);
      results.push(resourcesResult);

      // Cleanup
      await this.stopServer(validationId);

      // Calculate overall validity
      const criticalChecks = results.filter(r =>
        r.name.includes('initialize') ||
        r.name.includes('tools/list') ||
        r.name.includes('build')
      );
      const allCriticalPassed = criticalChecks.every(r => r.passed);
      const mostChecksPassed = results.filter(r => r.passed).length >= results.length * 0.8;
      const valid = allCriticalPassed && mostChecksPassed;

      return this.createResult(
        valid,
        results,
        errors,
        Date.now() - startTime,
        initResult.details?.serverInfo,
        tools.length,
        resourcesResult.details?.resourceCount
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`[${validationId}] Validation failed: ${errorMsg}`);
      errors.push(errorMsg);

      return this.createResult(false, results, errors, Date.now() - startTime);
    } finally {
      // Cleanup
      await this.stopServer(validationId);

      if (tempDir && existsSync(tempDir)) {
        try {
          rmSync(tempDir, { recursive: true, force: true });
        } catch (cleanupError) {
          this.logger.warn(`[${validationId}] Failed to cleanup temp directory: ${cleanupError}`);
        }
      }
    }
  }

  /**
   * Create temporary directory with server code
   */
  private async createTempServerDir(
    validationId: string,
    code: GeneratedCodeForProtocolValidation
  ): Promise<string> {
    const tempDir = join(this.tempBaseDir, `validation-${validationId}`);

    mkdirSync(tempDir, { recursive: true });
    mkdirSync(join(tempDir, 'src'), { recursive: true });

    writeFileSync(join(tempDir, 'src', 'index.ts'), code.mainFile);
    writeFileSync(join(tempDir, 'package.json'), code.packageJson);

    if (code.tsConfig) {
      writeFileSync(join(tempDir, 'tsconfig.json'), code.tsConfig);
    } else {
      writeFileSync(join(tempDir, 'tsconfig.json'), this.getDefaultTsConfig());
    }

    if (code.supportingFiles) {
      for (const [filePath, content] of Object.entries(code.supportingFiles)) {
        const fullPath = join(tempDir, filePath);
        mkdirSync(dirname(fullPath), { recursive: true });
        writeFileSync(fullPath, content);
      }
    }

    this.logger.debug(`[${validationId}] Created temp directory: ${tempDir}`);
    return tempDir;
  }

  /**
   * Build the server (npm install + tsc)
   */
  private async buildServer(validationId: string, serverDir: string): Promise<ValidationCheck> {
    const startTime = Date.now();

    try {
      // npm install
      await this.execCommand('npm', ['install'], serverDir, 120000);

      // TypeScript compilation
      await this.execCommand('npx', ['tsc'], serverDir, 60000);

      // Verify dist/index.js exists
      const distPath = join(serverDir, 'dist', 'index.js');
      if (!existsSync(distPath)) {
        return {
          name: 'build',
          passed: false,
          message: 'Build succeeded but dist/index.js not found',
          duration: Date.now() - startTime,
        };
      }

      return {
        name: 'build',
        passed: true,
        message: 'Server built successfully',
        duration: Date.now() - startTime,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        name: 'build',
        passed: false,
        message: errorMsg,
        duration: Date.now() - startTime,
      };
    }
  }

  /**
   * Execute shell command with timeout
   */
  private execCommand(
    command: string,
    args: string[],
    cwd: string,
    timeout: number
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout,
      });

      let stderr = '';
      let stdout = '';

      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('error', (error) => {
        reject(new Error(`${command} failed to start: ${error.message}`));
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`${command} failed with code ${code}: ${stderr || stdout}`));
        }
      });
    });
  }

  /**
   * Start MCP server process
   */
  private async startServer(validationId: string, serverDir: string): Promise<void> {
    const distPath = join(serverDir, 'dist', 'index.js');

    const serverProcess = spawn('node', [distPath], {
      cwd: serverDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'test' },
    });

    this.runningProcesses.set(validationId, {
      process: serverProcess,
      serverDir,
      pendingResponses: new Map(),
      buffer: '',
      stderrBuffer: '',
    });

    // Handle stdout (JSON-RPC responses)
    serverProcess.stdout?.on('data', (data) => {
      const processInfo = this.runningProcesses.get(validationId);
      if (!processInfo) return;

      processInfo.buffer += data.toString();
      const lines = processInfo.buffer.split('\n');
      processInfo.buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const response = JSON.parse(line);
          const pending = processInfo.pendingResponses.get(response.id);
          if (pending) {
            pending.resolve(response);
            processInfo.pendingResponses.delete(response.id);
          }
        } catch {
          // Non-JSON output, ignore
        }
      }
    });

    serverProcess.stderr?.on('data', (data) => {
      const processInfo = this.runningProcesses.get(validationId);
      if (processInfo) {
        processInfo.stderrBuffer += data.toString();
      }
    });

    // Wait for server to be ready
    await this.waitForServerReady(validationId, 10000);
  }

  /**
   * Wait for server to be ready
   */
  private async waitForServerReady(validationId: string, maxWaitMs: number): Promise<void> {
    const processInfo = this.runningProcesses.get(validationId);
    if (!processInfo) {
      throw new Error('Server process not found');
    }

    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      if (processInfo.process.exitCode !== null) {
        throw new Error(`Server exited with code ${processInfo.process.exitCode}: ${processInfo.stderrBuffer}`);
      }

      if (processInfo.process.stdin?.writable) {
        return;
      }

      await this.delay(100);
    }

    throw new Error(`Server failed to become ready within ${maxWaitMs}ms`);
  }

  /**
   * Stop MCP server process
   */
  private async stopServer(validationId: string): Promise<void> {
    const processInfo = this.runningProcesses.get(validationId);
    if (!processInfo) return;

    try {
      processInfo.process.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          processInfo.process.kill('SIGKILL');
          resolve();
        }, 3000);

        processInfo.process.on('close', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    } catch {
      // Ignore errors during cleanup
    }

    this.runningProcesses.delete(validationId);
  }

  /**
   * Send JSON-RPC message and wait for response
   */
  private async sendMessage(
    validationId: string,
    message: McpMessage,
    timeout: number = 10000
  ): Promise<McpResponse> {
    const processInfo = this.runningProcesses.get(validationId);
    if (!processInfo) {
      throw new Error('Server process not running');
    }

    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        processInfo.pendingResponses.delete(message.id);
        reject(new Error(`Message timeout after ${timeout}ms`));
      }, timeout);

      processInfo.pendingResponses.set(message.id, {
        resolve: (response: McpResponse) => {
          clearTimeout(timeoutHandle);
          resolve(response);
        },
        reject: (error: Error) => {
          clearTimeout(timeoutHandle);
          reject(error);
        },
      });

      try {
        processInfo.process.stdin!.write(JSON.stringify(message) + '\n');
      } catch (writeError) {
        processInfo.pendingResponses.delete(message.id);
        clearTimeout(timeoutHandle);
        reject(new Error(`Failed to write to server: ${writeError}`));
      }
    });
  }

  /**
   * Validate initialize handshake
   */
  private async validateInitialize(validationId: string): Promise<ValidationCheck> {
    const startTime = Date.now();

    try {
      const initMessage: McpMessage = {
        jsonrpc: '2.0',
        id: `init-${Date.now()}`,
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: {
            name: 'mcp-protocol-validator',
            version: '1.0.0',
          },
        },
      };

      const response = await this.sendMessage(validationId, initMessage);

      if (response.error) {
        return {
          name: 'initialize',
          passed: false,
          message: `Initialize error: ${response.error.message}`,
          details: response.error,
          duration: Date.now() - startTime,
        };
      }

      // Validate response structure
      const result = response.result;
      if (!result) {
        return {
          name: 'initialize',
          passed: false,
          message: 'Initialize response missing result',
          duration: Date.now() - startTime,
        };
      }

      if (!result.protocolVersion) {
        return {
          name: 'initialize',
          passed: false,
          message: 'Initialize response missing protocolVersion',
          duration: Date.now() - startTime,
        };
      }

      // Send initialized notification
      const processInfo = this.runningProcesses.get(validationId);
      if (processInfo) {
        processInfo.process.stdin!.write(JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/initialized',
        }) + '\n');
      }

      return {
        name: 'initialize',
        passed: true,
        message: `Protocol version: ${result.protocolVersion}`,
        details: {
          serverInfo: result.serverInfo,
          capabilities: result.capabilities,
          protocolVersion: result.protocolVersion,
        },
        duration: Date.now() - startTime,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        name: 'initialize',
        passed: false,
        message: errorMsg,
        duration: Date.now() - startTime,
      };
    }
  }

  /**
   * Validate tools/list response
   */
  private async validateToolsList(validationId: string): Promise<ValidationCheck> {
    const startTime = Date.now();

    try {
      const listMessage: McpMessage = {
        jsonrpc: '2.0',
        id: `tools-list-${Date.now()}`,
        method: 'tools/list',
        params: {},
      };

      const response = await this.sendMessage(validationId, listMessage);

      if (response.error) {
        return {
          name: 'tools/list',
          passed: false,
          message: `Tools list error: ${response.error.message}`,
          details: response.error,
          duration: Date.now() - startTime,
        };
      }

      const tools = response.result?.tools || [];

      // Validate each tool has required fields
      const invalidTools = tools.filter((t: any) =>
        !t.name || !t.description || !t.inputSchema
      );

      if (invalidTools.length > 0) {
        return {
          name: 'tools/list',
          passed: false,
          message: `${invalidTools.length} tool(s) missing required fields (name, description, inputSchema)`,
          details: { tools, invalidTools },
          duration: Date.now() - startTime,
        };
      }

      return {
        name: 'tools/list',
        passed: true,
        message: `${tools.length} valid tool(s) returned`,
        details: { tools, toolCount: tools.length },
        duration: Date.now() - startTime,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        name: 'tools/list',
        passed: false,
        message: errorMsg,
        duration: Date.now() - startTime,
      };
    }
  }

  /**
   * Validate tool input schemas against JSON Schema spec
   */
  private async validateToolSchemas(tools: any[]): Promise<ValidationCheck[]> {
    const results: ValidationCheck[] = [];

    for (const tool of tools) {
      const startTime = Date.now();
      const validation = this.schemaValidator.validateToolSchema(tool.name, tool.inputSchema);

      results.push({
        name: `schema:${tool.name}`,
        passed: validation.valid,
        message: validation.valid
          ? 'Input schema is valid JSON Schema'
          : validation.errors.join('; '),
        details: validation,
        duration: Date.now() - startTime,
      });
    }

    return results;
  }

  /**
   * Validate tool execution
   */
  private async validateToolExecution(
    validationId: string,
    tool: any
  ): Promise<ValidationCheck> {
    const startTime = Date.now();

    try {
      const sampleArgs = this.generateSampleArgs(tool.inputSchema);

      const callMessage: McpMessage = {
        jsonrpc: '2.0',
        id: `call-${tool.name}-${Date.now()}`,
        method: 'tools/call',
        params: {
          name: tool.name,
          arguments: sampleArgs,
        },
      };

      const response = await this.sendMessage(validationId, callMessage);

      // Check for MCP error response (which is still protocol-compliant)
      if (response.error) {
        const errorMsg = response.error.message || '';
        // Expected errors (missing API key, etc.) are acceptable
        const isExpectedError =
          errorMsg.includes('API key') ||
          errorMsg.includes('authentication') ||
          errorMsg.includes('credentials') ||
          errorMsg.includes('unauthorized');

        return {
          name: `tools/call:${tool.name}`,
          passed: isExpectedError, // Expected errors are acceptable
          message: isExpectedError
            ? 'Tool structure valid (needs credentials)'
            : `Tool error: ${errorMsg}`,
          details: { error: response.error, expectedError: isExpectedError },
          duration: Date.now() - startTime,
        };
      }

      // Validate response structure
      const result = response.result;
      if (!result?.content || !Array.isArray(result.content)) {
        return {
          name: `tools/call:${tool.name}`,
          passed: false,
          message: 'Response missing content array',
          details: { response: result },
          duration: Date.now() - startTime,
        };
      }

      // Validate content items have type field
      const invalidContent = result.content.filter((c: any) => !c.type);
      if (invalidContent.length > 0) {
        return {
          name: `tools/call:${tool.name}`,
          passed: false,
          message: 'Content items missing type field',
          details: { invalidContent },
          duration: Date.now() - startTime,
        };
      }

      return {
        name: `tools/call:${tool.name}`,
        passed: true,
        message: 'Tool responded with valid MCP format',
        details: { contentTypes: result.content.map((c: any) => c.type) },
        duration: Date.now() - startTime,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        name: `tools/call:${tool.name}`,
        passed: false,
        message: errorMsg,
        duration: Date.now() - startTime,
      };
    }
  }

  /**
   * Validate resources/list (optional capability)
   */
  private async validateResourcesList(validationId: string): Promise<ValidationCheck> {
    const startTime = Date.now();

    try {
      const listMessage: McpMessage = {
        jsonrpc: '2.0',
        id: `resources-list-${Date.now()}`,
        method: 'resources/list',
        params: {},
      };

      const response = await this.sendMessage(validationId, listMessage);

      // Resources are optional, so errors are acceptable
      if (response.error) {
        // Method not found means server doesn't support resources - this is fine
        if (response.error.code === -32601) {
          return {
            name: 'resources/list',
            passed: true,
            message: 'Server does not implement resources (optional)',
            details: { supported: false, resourceCount: 0 },
            duration: Date.now() - startTime,
          };
        }

        return {
          name: 'resources/list',
          passed: false,
          message: `Resources list error: ${response.error.message}`,
          details: response.error,
          duration: Date.now() - startTime,
        };
      }

      const resources = response.result?.resources || [];

      // Validate resource structure if any exist
      const invalidResources = resources.filter((r: any) =>
        !r.uri || !r.name
      );

      if (invalidResources.length > 0) {
        return {
          name: 'resources/list',
          passed: false,
          message: `${invalidResources.length} resource(s) missing required fields`,
          details: { resources, invalidResources, resourceCount: resources.length },
          duration: Date.now() - startTime,
        };
      }

      return {
        name: 'resources/list',
        passed: true,
        message: `${resources.length} valid resource(s) returned`,
        details: { resources, resourceCount: resources.length },
        duration: Date.now() - startTime,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        name: 'resources/list',
        passed: false,
        message: errorMsg,
        duration: Date.now() - startTime,
      };
    }
  }

  /**
   * Generate sample arguments from JSON Schema
   */
  private generateSampleArgs(schema: any): Record<string, any> {
    if (!schema || !schema.properties) {
      return {};
    }

    const args: Record<string, any> = {};

    for (const [key, prop] of Object.entries(schema.properties)) {
      const propDef = prop as any;

      if (propDef.type === 'string') {
        if (key.toLowerCase().includes('url')) {
          args[key] = 'https://example.com';
        } else if (key.toLowerCase().includes('email')) {
          args[key] = 'test@example.com';
        } else if (key.toLowerCase().includes('path')) {
          args[key] = '/tmp/test';
        } else {
          args[key] = 'sample_value';
        }
      } else if (propDef.type === 'number' || propDef.type === 'integer') {
        args[key] = propDef.minimum !== undefined ? propDef.minimum : 1;
      } else if (propDef.type === 'boolean') {
        args[key] = true;
      } else if (propDef.type === 'array') {
        args[key] = [];
      } else if (propDef.type === 'object') {
        args[key] = {};
      }
    }

    return args;
  }

  /**
   * Create validation result
   */
  private createResult(
    valid: boolean,
    checks: ValidationCheck[],
    errors: string[],
    totalDuration: number,
    serverInfo?: any,
    toolCount?: number,
    resourceCount?: number
  ): McpProtocolValidationResult {
    return {
      valid,
      checks,
      protocolVersion: MCP_PROTOCOL_VERSION,
      serverInfo,
      toolCount,
      resourceCount,
      totalDuration,
      errors,
    };
  }

  /**
   * Get default TypeScript config
   */
  private getDefaultTsConfig(): string {
    return JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'Node16',
        moduleResolution: 'Node16',
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        outDir: './dist',
        rootDir: './src',
      },
      include: ['src/**/*'],
    }, null, 2);
  }

  /**
   * Helper delay function
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
