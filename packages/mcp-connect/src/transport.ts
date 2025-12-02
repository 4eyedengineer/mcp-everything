import WebSocket from 'ws';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
  id: string | number | null;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
  id: string | number | null;
}

const REQUEST_TIMEOUT = 30000; // 30 seconds

export class StdioTransport {
  private ws: WebSocket | null = null;
  private useWebSocket = false;

  constructor(
    private serverUrl: string,
    private apiKey?: string,
  ) {}

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    return headers;
  }

  async send(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    // Use WebSocket for streaming methods, HTTP for simple requests
    if (this.useWebSocket) {
      return this.sendWebSocket(request);
    }

    return this.sendHttp(request);
  }

  private async sendHttp(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const response = await fetch(`${this.serverUrl}/mcp`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error(`Server error: ${response.status} ${response.statusText}`);
    }

    return response.json() as Promise<JsonRpcResponse>;
  }

  private async sendWebSocket(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await this.connectWebSocket();
    }

    return new Promise((resolve, reject) => {
      const handler = (data: WebSocket.RawData) => {
        try {
          const response = JSON.parse(data.toString()) as JsonRpcResponse;
          if (response.id === request.id) {
            this.ws!.off('message', handler);
            resolve(response);
          }
        } catch (e) {
          reject(e);
        }
      };

      this.ws!.on('message', handler);
      this.ws!.send(JSON.stringify(request));

      // Timeout
      setTimeout(() => {
        this.ws!.off('message', handler);
        reject(new Error('Request timeout'));
      }, REQUEST_TIMEOUT);
    });
  }

  private async connectWebSocket(): Promise<void> {
    const wsUrl = this.serverUrl.replace(/^https/, 'wss').replace(/^http/, 'ws');

    this.ws = new WebSocket(`${wsUrl}/mcp/stream`, {
      headers: this.getHeaders(),
    });

    await new Promise<void>((resolve, reject) => {
      this.ws!.on('open', resolve);
      this.ws!.on('error', reject);
    });
  }

  enableWebSocket(): void {
    this.useWebSocket = true;
  }

  disableWebSocket(): void {
    this.useWebSocket = false;
  }

  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
