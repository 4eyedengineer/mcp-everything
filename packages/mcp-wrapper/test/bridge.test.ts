import { MCPBridge, MCPRequest, MCPResponse } from '../src/mcp-bridge';

describe('MCPBridge', () => {
  describe('constructor', () => {
    it('should create a bridge with default timeout', () => {
      const bridge = new MCPBridge('echo', ['test']);
      expect(bridge).toBeInstanceOf(MCPBridge);
      expect(bridge.isRunning()).toBe(true);
      bridge.close();
    });

    it('should create a bridge with custom timeout', () => {
      const bridge = new MCPBridge('echo', ['test'], { timeout: 5000 });
      expect(bridge).toBeInstanceOf(MCPBridge);
      bridge.close();
    });
  });

  describe('sendRequest', () => {
    it('should send a request and receive a response', async () => {
      // Use a simple echo command that outputs valid JSON
      const bridge = new MCPBridge('node', [
        '-e',
        `
        const readline = require('readline');
        const rl = readline.createInterface({ input: process.stdin });
        rl.on('line', (line) => {
          const req = JSON.parse(line);
          console.log(JSON.stringify({
            jsonrpc: '2.0',
            id: req.id,
            result: { echo: req.method }
          }));
        });
        `,
      ]);

      const request: MCPRequest = {
        jsonrpc: '2.0',
        method: 'tools/list',
      };

      const response = await bridge.sendRequest(request);

      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBeDefined();
      expect(response.result).toEqual({ echo: 'tools/list' });

      bridge.close();
    }, 10000);

    it('should handle timeout', async () => {
      // Use a command that never responds
      const bridge = new MCPBridge(
        'node',
        ['-e', 'setTimeout(() => {}, 60000)'],
        { timeout: 100 }
      );

      const request: MCPRequest = {
        jsonrpc: '2.0',
        method: 'test',
      };

      await expect(bridge.sendRequest(request)).rejects.toThrow('timeout');

      bridge.close();
    }, 5000);

    it('should reject if bridge is closed', async () => {
      const bridge = new MCPBridge('echo', ['test']);
      bridge.close();

      const request: MCPRequest = {
        jsonrpc: '2.0',
        method: 'test',
      };

      await expect(bridge.sendRequest(request)).rejects.toThrow('not running');
    });
  });

  describe('isRunning', () => {
    it('should return true when process is running', () => {
      const bridge = new MCPBridge('node', [
        '-e',
        'setTimeout(() => {}, 60000)',
      ]);
      expect(bridge.isRunning()).toBe(true);
      bridge.close();
    });

    it('should return false after close', () => {
      const bridge = new MCPBridge('echo', ['test']);
      bridge.close();
      expect(bridge.isRunning()).toBe(false);
    });
  });

  describe('close', () => {
    it('should close the bridge gracefully', () => {
      const bridge = new MCPBridge('node', [
        '-e',
        'setTimeout(() => {}, 60000)',
      ]);
      expect(bridge.isRunning()).toBe(true);

      bridge.close();

      expect(bridge.isRunning()).toBe(false);
    });

    it('should handle multiple close calls', () => {
      const bridge = new MCPBridge('echo', ['test']);

      bridge.close();
      bridge.close();

      expect(bridge.isRunning()).toBe(false);
    });
  });
});

describe('MCPRequest interface', () => {
  it('should allow minimal request', () => {
    const request: MCPRequest = {
      jsonrpc: '2.0',
      method: 'test',
    };
    expect(request.jsonrpc).toBe('2.0');
    expect(request.method).toBe('test');
    expect(request.id).toBeUndefined();
    expect(request.params).toBeUndefined();
  });

  it('should allow full request', () => {
    const request: MCPRequest = {
      jsonrpc: '2.0',
      id: '123',
      method: 'tools/call',
      params: { name: 'test', arguments: {} },
    };
    expect(request.id).toBe('123');
    expect(request.params).toEqual({ name: 'test', arguments: {} });
  });
});

describe('MCPResponse interface', () => {
  it('should allow success response', () => {
    const response: MCPResponse = {
      jsonrpc: '2.0',
      id: '123',
      result: { tools: [] },
    };
    expect(response.result).toEqual({ tools: [] });
    expect(response.error).toBeUndefined();
  });

  it('should allow error response', () => {
    const response: MCPResponse = {
      jsonrpc: '2.0',
      id: '123',
      error: {
        code: -32600,
        message: 'Invalid Request',
      },
    };
    expect(response.error?.code).toBe(-32600);
    expect(response.result).toBeUndefined();
  });
});
