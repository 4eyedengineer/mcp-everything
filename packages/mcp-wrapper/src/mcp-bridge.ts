import { spawn, ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';

export interface MCPRequest {
  jsonrpc: '2.0';
  id?: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface MCPResponse {
  jsonrpc: '2.0';
  id: string;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface PendingRequest {
  resolve: (response: MCPResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export class MCPBridge {
  private process: ChildProcess;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private buffer = '';
  private isAlive = true;
  private readonly requestTimeout: number;

  constructor(
    command: string,
    args: string[],
    options: { timeout?: number } = {}
  ) {
    this.requestTimeout = options.timeout ?? 30000;

    this.process = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process.stdout?.on('data', (data: Buffer) => {
      this.buffer += data.toString();
      this.processBuffer();
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      console.error('[MCP Server Error]', data.toString());
    });

    this.process.on('error', (error: Error) => {
      console.error('[MCP Process Error]', error.message);
      this.isAlive = false;
      this.rejectAllPending(error);
    });

    this.process.on('exit', (code: number | null) => {
      console.log(`[MCP Process] Exited with code ${code}`);
      this.isAlive = false;
      this.rejectAllPending(new Error(`MCP process exited with code ${code}`));
    });
  }

  private processBuffer(): void {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const response = JSON.parse(line) as MCPResponse;
        const pending = this.pendingRequests.get(response.id);

        if (pending) {
          clearTimeout(pending.timeout);
          pending.resolve(response);
          this.pendingRequests.delete(response.id);
        } else {
          console.warn('[MCP Bridge] Received response for unknown request:', response.id);
        }
      } catch (e) {
        console.error('[MCP Bridge] Failed to parse response:', line);
      }
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pendingRequests.delete(id);
    }
  }

  async sendRequest(request: MCPRequest): Promise<MCPResponse> {
    if (!this.isAlive) {
      throw new Error('MCP process is not running');
    }

    return new Promise((resolve, reject) => {
      const id = request.id || randomUUID();
      const requestWithId: MCPRequest = { ...request, id };

      const timeout = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`MCP request timeout after ${this.requestTimeout}ms`));
        }
      }, this.requestTimeout);

      this.pendingRequests.set(id, { resolve, reject, timeout });

      const requestStr = JSON.stringify(requestWithId) + '\n';

      this.process.stdin?.write(requestStr, (error) => {
        if (error) {
          clearTimeout(timeout);
          this.pendingRequests.delete(id);
          reject(new Error(`Failed to send request: ${error.message}`));
        }
      });
    });
  }

  isRunning(): boolean {
    return this.isAlive && !this.process.killed;
  }

  close(): void {
    this.isAlive = false;
    this.rejectAllPending(new Error('MCP bridge closed'));

    if (!this.process.killed) {
      this.process.kill('SIGTERM');

      // Force kill after 5 seconds if still running
      setTimeout(() => {
        if (!this.process.killed) {
          this.process.kill('SIGKILL');
        }
      }, 5000);
    }
  }
}
