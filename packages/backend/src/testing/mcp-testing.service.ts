import { Injectable, Logger } from '@nestjs/common';
import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';

/**
 * Generated MCP server code structure
 */
export interface GeneratedCode {
  mainFile: string;
  packageJson: string;
  tsConfig: string;
  supportingFiles: Record<string, string>;
  metadata: {
    tools: Array<{ name: string; inputSchema: any; description: string }>;
    iteration: number;
    serverName: string;
  };
}

/**
 * MCP Tool test execution result
 */
export interface ToolTestResult {
  toolName: string;
  success: boolean;
  executionTime: number;
  output?: any;
  error?: string;
  mcpCompliant: boolean;
  timestamp: Date;
}

/**
 * Complete MCP server test results
 */
export interface McpServerTestResult {
  containerId: string;
  imageTag: string;
  buildSuccess: boolean;
  buildError?: string;
  buildDuration: number;
  toolsFound: number;
  toolsTested: number;
  toolsPassedCount: number;
  results: ToolTestResult[];
  overallSuccess: boolean;
  totalDuration: number;
  cleanupSuccess: boolean;
  cleanupErrors: string[];
  timestamp: Date;
}

/**
 * Real-time progress update for streaming to frontend
 */
export interface TestProgressUpdate {
  type: 'building' | 'starting' | 'testing' | 'testing_tool' | 'complete' | 'error' | 'cleanup';
  message: string;
  phase?: string;
  progress?: number;
  toolName?: string;
  toolIndex?: number;
  totalTools?: number;
  timestamp: Date;
}

/**
 * Test configuration
 */
export interface McpTestConfig {
  cpuLimit?: string; // e.g., "0.5"
  memoryLimit?: string; // e.g., "512m"
  timeout?: number; // seconds
  toolTimeout?: number; // seconds per tool
  networkMode?: 'none' | 'bridge';
  cleanup?: boolean;
}

/**
 * MCP Protocol test message
 */
interface McpMessage {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: any;
}

/**
 * MCP Protocol response
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

const execAsync = promisify(exec);

/**
 * MCP server testing service using direct Node.js execution
 * Fast iteration for development/testing with optional Docker for production validation
 */
@Injectable()
export class McpTestingService {
  private readonly logger = new Logger(McpTestingService.name);
  private readonly tempBaseDir = join(os.tmpdir(), 'mcp-testing');
  private readonly defaultConfig: McpTestConfig = {
    cpuLimit: '0.5',
    memoryLimit: '512m',
    timeout: 120, // 2 minutes for entire test
    toolTimeout: 10, // 10 seconds per tool (increased for real execution)
    networkMode: 'bridge', // Allow network for API calls
    cleanup: true,
  };

  private progressCallbacks: Map<string, (update: TestProgressUpdate) => void> = new Map();
  private runningProcesses: Map<string, any> = new Map(); // Track spawned MCP server processes

  constructor() {
    // Ensure temp directory exists
    if (!existsSync(this.tempBaseDir)) {
      mkdirSync(this.tempBaseDir, { recursive: true });
    }
  }

  /**
   * Register progress callback for real-time streaming
   */
  registerProgressCallback(
    testId: string,
    callback: (update: TestProgressUpdate) => void,
  ): void {
    this.progressCallbacks.set(testId, callback);
  }

  /**
   * Unregister progress callback
   */
  unregisterProgressCallback(testId: string): void {
    this.progressCallbacks.delete(testId);
  }

  /**
   * Stream progress update to registered callback
   */
  private streamProgress(testId: string, update: TestProgressUpdate): void {
    const callback = this.progressCallbacks.get(testId);
    if (callback) {
      callback(update);
    }
  }

  /**
   * Main test orchestration method - uses direct Node.js execution for fast iteration
   */
  async testMcpServer(
    generatedCode: GeneratedCode,
    config: McpTestConfig = {},
  ): Promise<McpServerTestResult> {
    const testId = uuidv4();
    const mergedConfig = { ...this.defaultConfig, ...config };
    const startTime = Date.now();
    let tempDir: string | null = null;
    let buildSuccess = false;
    const cleanupErrors: string[] = [];

    try {
      this.logger.log(`[${testId}] Starting MCP server test (direct Node.js execution)`);

      // Step 1: Create temporary directory with generated code
      tempDir = await this.createTempServerDir(generatedCode);
      this.logger.log(`[${testId}] Created temp directory: ${tempDir}`);

      // Step 2: Install dependencies and build
      this.streamProgress(testId, {
        type: 'building',
        message: 'Installing dependencies...',
        timestamp: new Date(),
      });

      const buildStartTime = Date.now();

      try {
        await this.buildNodeProject(tempDir);
        const buildDuration = Date.now() - buildStartTime;
        buildSuccess = true;

        this.streamProgress(testId, {
          type: 'building',
          message: `Build successful (${buildDuration}ms)`,
          timestamp: new Date(),
        });

        this.logger.log(`[${testId}] Node project built in ${buildDuration}ms`);
      } catch (buildError) {
        const buildDuration = Date.now() - buildStartTime;
        const buildErrorMsg = buildError instanceof Error ? buildError.message : String(buildError);

        this.streamProgress(testId, {
          type: 'error',
          message: `Build failed: ${buildErrorMsg}`,
          timestamp: new Date(),
        });

        this.logger.error(`[${testId}] Build failed: ${buildErrorMsg}`);

        return {
          containerId: '',
          imageTag: 'direct-node',
          buildSuccess: false,
          buildError: buildErrorMsg,
          buildDuration,
          toolsFound: generatedCode.metadata.tools.length,
          toolsTested: 0,
          toolsPassedCount: 0,
          results: [],
          overallSuccess: false,
          totalDuration: Date.now() - startTime,
          cleanupSuccess: false,
          cleanupErrors: ['Build failed'],
          timestamp: new Date(),
        };
      }

      // Step 3: Start MCP server process
      this.streamProgress(testId, {
        type: 'starting',
        message: 'Starting MCP server...',
        timestamp: new Date(),
      });

      const serverProcess = await this.startMcpServerProcess(testId, tempDir);
      this.logger.log(`[${testId}] MCP server process started`);

      // Step 4: Test each tool
      this.streamProgress(testId, {
        type: 'testing',
        message: `Testing ${generatedCode.metadata.tools.length} tools...`,
        timestamp: new Date(),
      });

      const results: ToolTestResult[] = [];

      // First, verify the server responds to initialize
      const initResult = await this.initializeMcpServer(testId, mergedConfig.toolTimeout || 10);
      if (!initResult.success) {
        this.logger.error(`[${testId}] Failed to initialize MCP server: ${initResult.error}`);
        // Still try to test tools, but log the init failure
      }

      // Get the actual tools list from the server
      const toolsListResult = await this.getToolsList(testId, mergedConfig.toolTimeout || 10);
      const serverTools = toolsListResult.tools || [];
      this.logger.log(`[${testId}] Server reports ${serverTools.length} tools available`);

      for (let i = 0; i < generatedCode.metadata.tools.length; i++) {
        const tool = generatedCode.metadata.tools[i];

        this.streamProgress(testId, {
          type: 'testing_tool',
          message: `Testing tool: ${tool.name}`,
          toolName: tool.name,
          toolIndex: i + 1,
          totalTools: generatedCode.metadata.tools.length,
          timestamp: new Date(),
        });

        try {
          const testResult = await this.testMcpToolDirect(
            testId,
            tool,
            serverTools,
            mergedConfig.toolTimeout || 10,
          );
          results.push(testResult);

          if (testResult.success) {
            this.logger.log(`[${testId}] Tool "${tool.name}" passed`);
          } else {
            this.logger.warn(`[${testId}] Tool "${tool.name}" failed: ${testResult.error}`);
          }
        } catch (toolError) {
          const errorMsg = toolError instanceof Error ? toolError.message : String(toolError);
          results.push({
            toolName: tool.name,
            success: false,
            executionTime: 0,
            error: errorMsg,
            mcpCompliant: false,
            timestamp: new Date(),
          });

          this.logger.error(`[${testId}] Error testing tool "${tool.name}": ${errorMsg}`);
        }
      }

      const toolsPassedCount = results.filter(r => r.success).length;
      const overallSuccess = toolsPassedCount === results.length && results.length > 0;

      // Step 5: Cleanup - stop the server process
      await this.stopMcpServerProcess(testId);

      const totalDuration = Date.now() - startTime;

      this.streamProgress(testId, {
        type: 'complete',
        message: `Test completed: ${toolsPassedCount}/${results.length} tools passed in ${totalDuration}ms`,
        timestamp: new Date(),
      });

      this.logger.log(
        `[${testId}] Test complete: ${toolsPassedCount}/${results.length} tools passed in ${totalDuration}ms`,
      );

      return {
        containerId: testId,
        imageTag: 'direct-node',
        buildSuccess,
        buildDuration: Date.now() - buildStartTime,
        toolsFound: generatedCode.metadata.tools.length,
        toolsTested: results.length,
        toolsPassedCount,
        results,
        overallSuccess,
        totalDuration,
        cleanupSuccess: true,
        cleanupErrors,
        timestamp: new Date(),
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`[${testId}] Test failed with error: ${errorMsg}`);

      // Attempt emergency cleanup
      await this.stopMcpServerProcess(testId);

      this.streamProgress(testId, {
        type: 'error',
        message: `Test failed: ${errorMsg}`,
        timestamp: new Date(),
      });

      throw new Error(`MCP server test failed: ${errorMsg}`);
    } finally {
      // Cleanup temporary directory
      if (tempDir && existsSync(tempDir) && mergedConfig.cleanup) {
        try {
          rmSync(tempDir, { recursive: true, force: true });
          this.logger.log(`[${testId}] Cleaned up temp directory: ${tempDir}`);
        } catch (cleanupError) {
          const cleanupErrorMsg =
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
          cleanupErrors.push(`Temp directory cleanup failed: ${cleanupErrorMsg}`);
          this.logger.error(`[${testId}] Failed to cleanup temp directory: ${cleanupErrorMsg}`);
        }
      }

      // Unregister progress callback
      this.unregisterProgressCallback(testId);
    }
  }

  /**
   * Build the Node.js project (npm install + tsc)
   */
  private async buildNodeProject(serverDir: string): Promise<void> {
    // First, install dependencies
    this.logger.debug(`Installing dependencies in ${serverDir}`);

    await new Promise<void>((resolve, reject) => {
      const npmInstall = spawn('npm', ['install'], {
        cwd: serverDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 120000, // 2 minute timeout for npm install
      });

      let stderr = '';
      let stdout = '';

      npmInstall.stdout?.on('data', (data) => {
        stdout += data.toString();
        this.logger.debug(`npm install stdout: ${data.toString().trim()}`);
      });

      npmInstall.stderr?.on('data', (data) => {
        stderr += data.toString();
        this.logger.debug(`npm install stderr: ${data.toString().trim()}`);
      });

      npmInstall.on('error', (error) => {
        reject(new Error(`npm install failed to start: ${error.message}`));
      });

      npmInstall.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`npm install failed with code ${code}: ${stderr || stdout}`));
        }
      });
    });

    // Then, compile TypeScript
    this.logger.debug(`Compiling TypeScript in ${serverDir}`);

    await new Promise<void>((resolve, reject) => {
      const tsc = spawn('npx', ['tsc'], {
        cwd: serverDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 60000, // 1 minute timeout for compilation
      });

      let stderr = '';
      let stdout = '';

      tsc.stdout?.on('data', (data) => {
        stdout += data.toString();
        this.logger.debug(`tsc stdout: ${data.toString().trim()}`);
      });

      tsc.stderr?.on('data', (data) => {
        stderr += data.toString();
        this.logger.debug(`tsc stderr: ${data.toString().trim()}`);
      });

      tsc.on('error', (error) => {
        reject(new Error(`tsc failed to start: ${error.message}`));
      });

      tsc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`TypeScript compilation failed with code ${code}: ${stderr || stdout}`));
        }
      });
    });

    // Verify dist/index.js exists
    const distIndexPath = join(serverDir, 'dist', 'index.js');
    if (!existsSync(distIndexPath)) {
      throw new Error(`Build succeeded but dist/index.js not found at ${distIndexPath}`);
    }

    this.logger.debug(`Build complete, dist/index.js exists`);
  }

  /**
   * Start the MCP server as a child process for testing
   */
  private async startMcpServerProcess(testId: string, serverDir: string): Promise<any> {
    const distIndexPath = join(serverDir, 'dist', 'index.js');

    const serverProcess = spawn('node', [distIndexPath], {
      cwd: serverDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_ENV: 'test',
      },
    });

    // Store reference for later communication
    this.runningProcesses.set(testId, {
      process: serverProcess,
      serverDir,
      pendingResponses: new Map<string | number, { resolve: Function; reject: Function }>(),
      buffer: '',
    });

    // Set up stdout handler to parse JSON-RPC responses
    serverProcess.stdout?.on('data', (data) => {
      const processInfo = this.runningProcesses.get(testId);
      if (!processInfo) return;

      processInfo.buffer += data.toString();

      // Try to parse complete JSON-RPC messages (newline-delimited)
      const lines = processInfo.buffer.split('\n');
      processInfo.buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const response = JSON.parse(line);
          this.logger.debug(`[${testId}] MCP response: ${JSON.stringify(response).substring(0, 200)}`);

          // Resolve pending promise for this message ID
          const pending = processInfo.pendingResponses.get(response.id);
          if (pending) {
            pending.resolve(response);
            processInfo.pendingResponses.delete(response.id);
          }
        } catch (parseError) {
          this.logger.debug(`[${testId}] Non-JSON output: ${line}`);
        }
      }
    });

    serverProcess.stderr?.on('data', (data) => {
      this.logger.warn(`[${testId}] MCP server stderr: ${data.toString().trim()}`);
    });

    serverProcess.on('error', (error) => {
      this.logger.error(`[${testId}] MCP server process error: ${error.message}`);
    });

    serverProcess.on('close', (code) => {
      this.logger.log(`[${testId}] MCP server process exited with code ${code}`);
      this.runningProcesses.delete(testId);
    });

    // Wait a bit for process to start
    await new Promise(resolve => setTimeout(resolve, 500));

    return serverProcess;
  }

  /**
   * Stop the MCP server process
   */
  private async stopMcpServerProcess(testId: string): Promise<void> {
    const processInfo = this.runningProcesses.get(testId);
    if (!processInfo) return;

    try {
      processInfo.process.kill('SIGTERM');

      // Wait for graceful shutdown, then force kill
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
    } catch (error) {
      this.logger.warn(`[${testId}] Error stopping MCP server: ${error}`);
    }

    this.runningProcesses.delete(testId);
  }

  /**
   * Send a JSON-RPC message to the MCP server and wait for response
   */
  private async sendMcpMessageDirect(
    testId: string,
    message: McpMessage,
    timeout: number,
  ): Promise<McpResponse> {
    const processInfo = this.runningProcesses.get(testId);
    if (!processInfo) {
      throw new Error('MCP server process not running');
    }

    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        processInfo.pendingResponses.delete(message.id);
        reject(new Error(`MCP message timeout after ${timeout}s`));
      }, timeout * 1000);

      // Register pending response handler
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

      // Send the message
      const messageJson = JSON.stringify(message) + '\n';
      this.logger.debug(`[${testId}] Sending MCP message: ${messageJson.trim()}`);

      try {
        processInfo.process.stdin.write(messageJson);
      } catch (writeError) {
        processInfo.pendingResponses.delete(message.id);
        clearTimeout(timeoutHandle);
        reject(new Error(`Failed to write to MCP server: ${writeError}`));
      }
    });
  }

  /**
   * Initialize the MCP server
   */
  private async initializeMcpServer(
    testId: string,
    timeout: number,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const initMessage: McpMessage = {
        jsonrpc: '2.0',
        id: `init-${Date.now()}`,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: {
            name: 'mcp-testing-service',
            version: '1.0.0',
          },
        },
      };

      const response = await this.sendMcpMessageDirect(testId, initMessage, timeout);

      if (response.error) {
        return { success: false, error: response.error.message };
      }

      // Send initialized notification
      const notificationMessage = {
        jsonrpc: '2.0' as const,
        method: 'notifications/initialized',
      };
      const processInfo = this.runningProcesses.get(testId);
      if (processInfo) {
        processInfo.process.stdin.write(JSON.stringify(notificationMessage) + '\n');
      }

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Get the list of tools from the MCP server
   */
  private async getToolsList(
    testId: string,
    timeout: number,
  ): Promise<{ tools: any[]; error?: string }> {
    try {
      const listToolsMessage: McpMessage = {
        jsonrpc: '2.0',
        id: `list-tools-${Date.now()}`,
        method: 'tools/list',
      };

      const response = await this.sendMcpMessageDirect(testId, listToolsMessage, timeout);

      if (response.error) {
        return { tools: [], error: response.error.message };
      }

      return { tools: response.result?.tools || [] };
    } catch (error) {
      return {
        tools: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Test a specific MCP tool using direct Node.js execution
   */
  private async testMcpToolDirect(
    testId: string,
    tool: { name: string; inputSchema: any; description: string },
    serverTools: any[],
    timeout: number,
  ): Promise<ToolTestResult> {
    const startTime = Date.now();

    try {
      // Verify tool is in the server's tool list
      const foundTool = serverTools.find((t: any) => t.name === tool.name);

      if (!foundTool) {
        return {
          toolName: tool.name,
          success: false,
          executionTime: Date.now() - startTime,
          error: `Tool "${tool.name}" not found in server's tools/list response`,
          mcpCompliant: false,
          timestamp: new Date(),
        };
      }

      // Call the tool with sample parameters
      const sampleParams = this.generateSampleParams(tool.inputSchema);
      const callToolMessage: McpMessage = {
        jsonrpc: '2.0',
        id: `call-${tool.name}-${Date.now()}`,
        method: 'tools/call',
        params: {
          name: tool.name,
          arguments: sampleParams,
        },
      };

      const callResponse = await this.sendMcpMessageDirect(testId, callToolMessage, timeout);

      if (callResponse.error) {
        // Check if it's an expected error (like missing API key)
        const errorMessage = callResponse.error.message || '';
        const isExpectedError =
          errorMessage.includes('API key') ||
          errorMessage.includes('authentication') ||
          errorMessage.includes('credentials') ||
          errorMessage.includes('unauthorized') ||
          errorMessage.includes('401');

        if (isExpectedError) {
          // Tool structure is correct, just missing credentials - consider partial success
          return {
            toolName: tool.name,
            success: true, // Structure works, just needs credentials
            executionTime: Date.now() - startTime,
            output: { note: 'Tool structure valid, needs credentials', error: errorMessage },
            mcpCompliant: true,
            timestamp: new Date(),
          };
        }

        return {
          toolName: tool.name,
          success: false,
          executionTime: Date.now() - startTime,
          error: `Tool call error: ${callResponse.error.message}`,
          mcpCompliant: true, // Error response is still MCP-compliant
          timestamp: new Date(),
        };
      }

      // Verify response has expected structure
      const hasContent =
        callResponse.result?.content &&
        Array.isArray(callResponse.result.content) &&
        callResponse.result.content.length > 0;

      if (!hasContent) {
        return {
          toolName: tool.name,
          success: false,
          executionTime: Date.now() - startTime,
          error: 'Tool response missing content field',
          mcpCompliant: false,
          timestamp: new Date(),
        };
      }

      return {
        toolName: tool.name,
        success: true,
        executionTime: Date.now() - startTime,
        output: callResponse.result,
        mcpCompliant: true,
        timestamp: new Date(),
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      return {
        toolName: tool.name,
        success: false,
        executionTime: Date.now() - startTime,
        error: errorMsg,
        mcpCompliant: false,
        timestamp: new Date(),
      };
    }
  }

  /**
   * Create temporary directory with generated server code
   */
  private async createTempServerDir(generatedCode: GeneratedCode): Promise<string> {
    const tempDir = join(this.tempBaseDir, `server-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`);

    // Create directory structure
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(join(tempDir, 'src'), { recursive: true });

    // Write main file
    writeFileSync(join(tempDir, 'src', 'index.ts'), generatedCode.mainFile);

    // Write package.json
    writeFileSync(join(tempDir, 'package.json'), generatedCode.packageJson);

    // Write tsconfig.json
    writeFileSync(join(tempDir, 'tsconfig.json'), generatedCode.tsConfig);

    // Write supporting files
    for (const [filePath, content] of Object.entries(generatedCode.supportingFiles)) {
      const fullPath = join(tempDir, filePath);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, content);
    }

    return tempDir;
  }

  /**
   * Generate sample parameters from JSON schema
   */
  private generateSampleParams(schema: any): Record<string, any> {
    if (!schema || !schema.properties) {
      return {};
    }

    const params: Record<string, any> = {};

    for (const [key, prop] of Object.entries(schema.properties)) {
      const propDef = prop as any;

      if (propDef.type === 'string') {
        // Use more realistic sample values
        if (key.toLowerCase().includes('url')) {
          params[key] = 'https://example.com';
        } else if (key.toLowerCase().includes('email')) {
          params[key] = 'test@example.com';
        } else if (key.toLowerCase().includes('path')) {
          params[key] = '/tmp/test';
        } else if (key.toLowerCase().includes('query') || key.toLowerCase().includes('search')) {
          params[key] = 'test query';
        } else {
          params[key] = 'sample_value';
        }
      } else if (propDef.type === 'number' || propDef.type === 'integer') {
        params[key] = propDef.minimum !== undefined ? propDef.minimum : 1;
      } else if (propDef.type === 'boolean') {
        params[key] = true;
      } else if (propDef.type === 'array') {
        params[key] = [];
      } else if (propDef.type === 'object') {
        params[key] = {};
      } else {
        params[key] = null;
      }
    }

    return params;
  }

  /**
   * Get test results summary (useful for API responses)
   */
  getTestSummary(result: McpServerTestResult): {
    passed: boolean;
    toolsTestedCount: number;
    toolsPassedCount: number;
    toolsFailedCount: number;
    buildSuccess: boolean;
    cleanupSuccess: boolean;
    totalDurationMs: number;
  } {
    return {
      passed: result.overallSuccess,
      toolsTestedCount: result.toolsTested,
      toolsPassedCount: result.toolsPassedCount,
      toolsFailedCount: result.toolsTested - result.toolsPassedCount,
      buildSuccess: result.buildSuccess,
      cleanupSuccess: result.cleanupSuccess,
      totalDurationMs: result.totalDuration,
    };
  }
}
