import * as fs from 'fs';

// Mock fs module before importing config
jest.mock('fs');
const mockFs = fs as jest.Mocked<typeof fs>;

import { loadConfig, saveConfig, getConfigPath, Config } from '../src/config';
import { getApiKey } from '../src/auth';
import { resolveServerBaseUrl, mcpEndpoint, healthEndpoint, DEFAULT_DOMAIN } from '../src/url';
import { formatTransportError } from '../src/errors';
import { McpProxy, ProxyLogger } from '../src/proxy';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

describe('Config Module', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  describe('loadConfig', () => {
    it('should return empty object when no config file exists', () => {
      mockFs.existsSync.mockReturnValue(false);

      const config = loadConfig();

      expect(config).toEqual({});
    });

    it('should load config from primary path', () => {
      const expectedConfig: Config = {
        baseUrl: 'https://custom.mcp.com',
        apiKeys: { default: 'test-key' },
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(expectedConfig));

      const config = loadConfig();

      expect(config).toEqual(expectedConfig);
    });

    it('should return empty object on invalid JSON', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('invalid json');

      // Suppress console.error for this test
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      const config = loadConfig();

      expect(config).toEqual({});
      consoleSpy.mockRestore();
    });
  });

  describe('saveConfig', () => {
    it('should create config directory if it does not exist', () => {
      mockFs.existsSync.mockReturnValue(false);
      mockFs.mkdirSync.mockImplementation();
      mockFs.writeFileSync.mockImplementation();

      const config: Config = { baseUrl: 'https://test.com' };
      saveConfig(config);

      expect(mockFs.mkdirSync).toHaveBeenCalled();
      const mkdirCall = mockFs.mkdirSync.mock.calls[0];
      expect(mkdirCall[0].toString()).toContain('.mcpeverything');
      expect(mkdirCall[1]).toEqual({ recursive: true });
    });

    it('should write config as formatted JSON', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.writeFileSync.mockImplementation();

      const config: Config = { baseUrl: 'https://test.com' };
      saveConfig(config);

      expect(mockFs.writeFileSync).toHaveBeenCalled();
      const writeCall = mockFs.writeFileSync.mock.calls[0];
      expect(writeCall[0].toString()).toContain('config.json');
      expect(writeCall[1]).toEqual(JSON.stringify(config, null, 2));
    });
  });

  describe('getConfigPath', () => {
    it('should return path in home directory', () => {
      const configPath = getConfigPath();

      expect(configPath).toContain('.mcpeverything');
      expect(configPath).toContain('config.json');
    });
  });
});

describe('Auth Module', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...originalEnv };
    delete process.env.MCPEVERYTHING_API_KEY;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should prefer environment variable over config', () => {
    process.env.MCPEVERYTHING_API_KEY = 'env-key';
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify({ apiKeys: { default: 'config-key' } }));

    const apiKey = getApiKey('test-server');

    expect(apiKey).toBe('env-key');
  });

  it('should use server-specific key from config', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        apiKeys: {
          default: 'default-key',
          'test-server': 'server-specific-key',
        },
      }),
    );

    const apiKey = getApiKey('test-server');

    expect(apiKey).toBe('server-specific-key');
  });

  it('should fall back to default key', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify({ apiKeys: { default: 'default-key' } }));

    const apiKey = getApiKey('unknown-server');

    expect(apiKey).toBe('default-key');
  });

  it('should return undefined when no key is configured', () => {
    mockFs.existsSync.mockReturnValue(false);

    const apiKey = getApiKey('test-server');

    expect(apiKey).toBeUndefined();
  });
});

describe('resolveServerBaseUrl', () => {
  it('passes a full https:// URL through unchanged (minus trailing slash)', () => {
    expect(resolveServerBaseUrl('https://my-server.mcp.example.com/')).toBe(
      'https://my-server.mcp.example.com',
    );
  });

  it('passes a full http:// URL through unchanged (e.g. docker-run localhost hosting)', () => {
    expect(resolveServerBaseUrl('http://localhost:8080')).toBe('http://localhost:8080');
  });

  it('expands a bare server ID into https://<id>.<domain>, matching HostingService.deployToCloud', () => {
    expect(resolveServerBaseUrl('stripe-abc123k9', 'mcp.example.com')).toBe(
      'https://stripe-abc123k9.mcp.example.com',
    );
  });

  it('uses DEFAULT_DOMAIN when no domain is supplied', () => {
    expect(resolveServerBaseUrl('stripe-abc123k9')).toBe(`https://stripe-abc123k9.${DEFAULT_DOMAIN}`);
  });

  it('rejects input that is neither a URL nor a valid server ID', () => {
    expect(() => resolveServerBaseUrl('not a valid id!')).toThrow(/neither a URL/i);
  });

  it('rejects a server ID starting or ending with a hyphen', () => {
    expect(() => resolveServerBaseUrl('-bad-id-')).toThrow();
  });
});

describe('mcpEndpoint / healthEndpoint', () => {
  it('appends /mcp and /health to the base URL', () => {
    expect(mcpEndpoint('https://foo.mcp.example.com')).toBe('https://foo.mcp.example.com/mcp');
    expect(healthEndpoint('https://foo.mcp.example.com')).toBe('https://foo.mcp.example.com/health');
  });
});

describe('formatTransportError', () => {
  it('explains ECONNREFUSED as a dead/unreachable server', () => {
    const err = new Error('fetch failed') as NodeJS.ErrnoException;
    (err as unknown as { cause: unknown }).cause = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });
    const message = formatTransportError(err, 'http://localhost:1');
    expect(message).toMatch(/connection refused/i);
    expect(message).toContain('http://localhost:1');
  });

  it('explains ENOTFOUND as a DNS problem', () => {
    const err = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    const message = formatTransportError(err, 'https://nope.example.com');
    expect(message).toMatch(/resolve host|DNS/i);
  });

  it('explains HTTP 404 from StreamableHTTPError-shaped errors', () => {
    const err = Object.assign(new Error('Streamable HTTP error: Error POSTing to endpoint: not found'), {
      code: 404,
    });
    const message = formatTransportError(err, 'https://foo.mcp.example.com');
    expect(message).toMatch(/404/);
    expect(message).toMatch(/no mcp server found/i);
  });

  it('explains HTTP 406 as an Accept-header mismatch', () => {
    const err = Object.assign(new Error('Streamable HTTP error: Not Acceptable'), { code: 406 });
    const message = formatTransportError(err, 'https://foo.mcp.example.com');
    expect(message).toMatch(/406/);
    expect(message).toMatch(/accept header/i);
  });

  it('explains HTTP 401/403 as an auth failure', () => {
    const err = Object.assign(new Error('Streamable HTTP error: unauthorized'), { code: 401 });
    const message = formatTransportError(err, 'https://foo.mcp.example.com');
    expect(message).toMatch(/authentication failed/i);
    expect(message).toMatch(/MCPEVERYTHING_API_KEY/);
  });
});

/** Minimal fake Transport for testing McpProxy's wiring without real I/O. */
class FakeTransport implements Transport {
  sent: JSONRPCMessage[] = [];
  started = false;
  closed = false;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  setProtocolVersion = jest.fn();

  async start(): Promise<void> {
    this.started = true;
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.sent.push(message);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.onclose?.();
  }
}

function silentLogger(): ProxyLogger {
  return { info: jest.fn(), error: jest.fn() };
}

describe('McpProxy', () => {
  it('starts both transports and forwards local -> remote', async () => {
    const local = new FakeTransport();
    const remote = new FakeTransport();
    const proxy = new McpProxy(local, remote, silentLogger(), 'https://foo.mcp.example.com');

    await proxy.start();
    expect(local.started).toBe(true);
    expect(remote.started).toBe(true);

    const request: JSONRPCMessage = { jsonrpc: '2.0', method: 'tools/list', id: 1 };
    local.onmessage?.(request);

    expect(remote.sent).toEqual([request]);
  });

  it('forwards remote -> local (server responses reach Claude Desktop)', async () => {
    const local = new FakeTransport();
    const remote = new FakeTransport();
    const proxy = new McpProxy(local, remote, silentLogger(), 'https://foo.mcp.example.com');
    await proxy.start();

    const response: JSONRPCMessage = { jsonrpc: '2.0', result: { tools: [] }, id: 1 };
    remote.onmessage?.(response);

    expect(local.sent).toEqual([response]);
  });

  it('captures the negotiated protocol version from the initialize response', async () => {
    const local = new FakeTransport();
    const remote = new FakeTransport();
    const proxy = new McpProxy(local, remote, silentLogger(), 'https://foo.mcp.example.com');
    await proxy.start();

    const initRequest: JSONRPCMessage = {
      jsonrpc: '2.0',
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'x', version: '1' } },
      id: 'init-1',
    };
    local.onmessage?.(initRequest);

    const initResponse: JSONRPCMessage = {
      jsonrpc: '2.0',
      result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 's', version: '1' } },
      id: 'init-1',
    };
    remote.onmessage?.(initResponse);

    expect(remote.setProtocolVersion).toHaveBeenCalledWith('2025-11-25');
  });

  it('does not confuse an unrelated response with the initialize response', async () => {
    const local = new FakeTransport();
    const remote = new FakeTransport();
    const proxy = new McpProxy(local, remote, silentLogger(), 'https://foo.mcp.example.com');
    await proxy.start();

    const unrelatedResponse: JSONRPCMessage = { jsonrpc: '2.0', result: { ok: true }, id: 'other' };
    remote.onmessage?.(unrelatedResponse);

    expect(remote.setProtocolVersion).not.toHaveBeenCalled();
  });

  it('logs a formatted error and does not throw when remote.send rejects', async () => {
    const local = new FakeTransport();
    const remote = new FakeTransport();
    remote.send = jest.fn().mockRejectedValue(Object.assign(new Error('boom'), { code: 404 }));
    const logger = silentLogger();
    const proxy = new McpProxy(local, remote, logger, 'https://foo.mcp.example.com');
    await proxy.start();

    local.onmessage?.({ jsonrpc: '2.0', method: 'tools/call', id: 2 });
    // allow the rejected promise's .catch handler to run
    await new Promise((resolve) => setImmediate(resolve));

    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/404/));
  });

  it('closes both transports exactly once when either side closes', async () => {
    const local = new FakeTransport();
    const remote = new FakeTransport();
    const proxy = new McpProxy(local, remote, silentLogger(), 'https://foo.mcp.example.com');
    await proxy.start();

    await proxy.close();
    expect(local.closed).toBe(true);
    expect(remote.closed).toBe(true);

    // A second close() (e.g. triggered by the other side's onclose firing
    // after the first close() already tore both sides down) must be a no-op.
    local.closed = false;
    remote.closed = false;
    await proxy.close();
    expect(local.closed).toBe(false);
    expect(remote.closed).toBe(false);
  });
});
