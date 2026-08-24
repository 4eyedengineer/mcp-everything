import * as http from 'http';
import { AddressInfo } from 'net';
import {
  McpTestingService,
  McpHttpTransportClient,
  allocateFreePort,
  McpMessage,
} from './mcp-testing.service';
import {
  FIXTURE_SIMPLE_WORKING_SERVER,
  FIXTURE_HTTP_WORKING_SERVER,
  FIXTURE_HTTP_INCOMPLETE_SERVER,
} from './testing.fixtures';

// This environment has no Docker daemon, so every full-integration test below
// runs the same "unsandboxed" code path a Docker-less CI runner would use.
// Setting this here (rather than relying on it being set externally) means
// these tests pass regardless of whether Docker happens to be available.
process.env.MCP_TESTING_ALLOW_UNSANDBOXED = 'true';

describe('McpTestingService — dual transport (stdio + HTTP)', () => {
  // Real npm install + tsc + process start/handshake per test; generous timeout.
  jest.setTimeout(60000);

  let service: McpTestingService;

  beforeEach(() => {
    service = new McpTestingService();
  });

  afterEach(async () => {
    await service.onModuleDestroy();
  });

  it('defaults to the HTTP transport and passes all tools end-to-end (build, start, initialize, tools/list, tools/call)', async () => {
    const result = await service.testMcpServer(FIXTURE_HTTP_WORKING_SERVER, {
      timeout: 60,
      toolTimeout: 10,
      cleanup: true,
      // transport intentionally omitted — must default to 'http'.
    });

    expect(result.buildSuccess).toBe(true);
    expect(result.toolsFound).toBe(2);
    expect(result.toolsTested).toBe(2);
    expect(result.toolsPassedCount).toBe(2);
    expect(result.overallSuccess).toBe(true);
    expect(result.results.map((r) => r.toolName).sort()).toEqual(['add', 'multiply']);
  });

  it('still supports the legacy stdio transport when explicitly requested (regression check)', async () => {
    const result = await service.testMcpServer(FIXTURE_SIMPLE_WORKING_SERVER, {
      timeout: 60,
      toolTimeout: 10,
      cleanup: true,
      transport: 'stdio',
    });

    expect(result.buildSuccess).toBe(true);
    expect(result.toolsPassedCount).toBe(result.toolsFound);
    expect(result.overallSuccess).toBe(true);
  });

  it('surfaces a clear readiness-timeout error when the HTTP server builds but never binds its listener', async () => {
    await expect(
      service.testMcpServer(FIXTURE_HTTP_INCOMPLETE_SERVER, {
        timeout: 30,
        toolTimeout: 5,
        cleanup: true,
      }),
    ).rejects.toThrow(/failed to become ready/i);
  });
});

describe('allocateFreePort', () => {
  it('returns a port that a server can actually bind to', async () => {
    const port = await allocateFreePort();
    expect(port).toBeGreaterThan(0);

    const server = http.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    const address = server.address() as AddressInfo;
    expect(address.port).toBe(port);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns distinct ports across concurrent calls', async () => {
    const ports = await Promise.all([allocateFreePort(), allocateFreePort(), allocateFreePort()]);
    expect(new Set(ports).size).toBe(ports.length);
  });
});

/**
 * Unit tests for the shared MCP Streamable HTTP client against a minimal
 * fake server that reproduces the exact wire behavior empirically confirmed
 * against a real `StreamableHTTPServerTransport` (see class doc comment on
 * McpHttpTransportClient): the required Accept header, the Mcp-Session-Id
 * response header, and SSE-framed response bodies.
 */
describe('McpHttpTransportClient', () => {
  let server: http.Server;
  let baseUrl: string;
  let lastAcceptHeader: string | undefined;
  let lastSessionIdHeader: string | undefined;
  let sessionIssued = false;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        lastAcceptHeader = req.headers['accept'];
        lastSessionIdHeader = req.headers['mcp-session-id'] as string | undefined;

        if (req.url === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
          return;
        }

        // Enforce the real server's Accept-header requirement.
        const accept = req.headers['accept'] || '';
        if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
          res.writeHead(406, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32000, message: 'Not Acceptable' },
              id: null,
            }),
          );
          return;
        }

        const body = Buffer.concat(chunks).toString('utf-8');
        const message = body.length > 0 ? JSON.parse(body) : undefined;

        // Fire-and-forget notification.
        if (message && !('id' in message)) {
          res.writeHead(202);
          res.end();
          return;
        }

        const headers: Record<string, string> = { 'Content-Type': 'text/event-stream' };
        if (message?.method === 'initialize') {
          sessionIssued = true;
          headers['Mcp-Session-Id'] = 'fake-session-id-123';
        }

        const responsePayload = {
          jsonrpc: '2.0',
          id: message.id,
          result: { echoedMethod: message.method },
        };

        res.writeHead(200, headers);
        res.end(`event: message\ndata: ${JSON.stringify(responsePayload)}\n\n`);
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('isHealthy() returns true once the fake server is up', async () => {
    const client = new McpHttpTransportClient(baseUrl);
    expect(await client.isHealthy()).toBe(true);
  });

  it('isHealthy() returns false for an unreachable server (no throw)', async () => {
    const client = new McpHttpTransportClient('http://127.0.0.1:1');
    expect(await client.isHealthy()).toBe(false);
  });

  it('sends the required Accept header and parses the SSE-framed response', async () => {
    const client = new McpHttpTransportClient(baseUrl);
    const message: McpMessage = { jsonrpc: '2.0', id: 'x-1', method: 'tools/list' };

    const response = await client.send(message, 5000);

    expect(lastAcceptHeader).toBe('application/json, text/event-stream');
    expect(response.id).toBe('x-1');
    expect(response.result).toEqual({ echoedMethod: 'tools/list' });
  });

  it('captures Mcp-Session-Id on initialize and echoes it on subsequent requests', async () => {
    const client = new McpHttpTransportClient(baseUrl);

    await client.send({ jsonrpc: '2.0', id: 'init-1', method: 'initialize' }, 5000);
    expect(sessionIssued).toBe(true);
    expect(lastSessionIdHeader).toBeUndefined(); // not sent on the initialize request itself

    await client.send({ jsonrpc: '2.0', id: 'list-1', method: 'tools/list' }, 5000);
    expect(lastSessionIdHeader).toBe('fake-session-id-123');
  });

  it('notify() sends a fire-and-forget notification and resolves without a response body', async () => {
    const client = new McpHttpTransportClient(baseUrl);
    await expect(client.notify('notifications/initialized')).resolves.toBeUndefined();
  });
});

// Security property: the unsandboxed escape hatch must never arm in
// production, no matter what the environment variable says. These are pure
// construction-time checks (no Docker, no npm install), so they run instantly.
describe('McpTestingService — unsandboxed escape hatch is production-gated', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalFlag = process.env.MCP_TESTING_ALLOW_UNSANDBOXED;

  afterEach(() => {
    // Restore so the flag stays 'true' for the integration suite above/below.
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalFlag === undefined) delete process.env.MCP_TESTING_ALLOW_UNSANDBOXED;
    else process.env.MCP_TESTING_ALLOW_UNSANDBOXED = originalFlag;
  });

  it('refuses the escape hatch under NODE_ENV=production even when the flag is set', () => {
    process.env.MCP_TESTING_ALLOW_UNSANDBOXED = 'true';
    process.env.NODE_ENV = 'production';
    const service = new McpTestingService();
    expect((service as unknown as { allowUnsandboxed: boolean }).allowUnsandboxed).toBe(false);
  });

  it('honours the escape hatch outside production when the flag is set', () => {
    process.env.MCP_TESTING_ALLOW_UNSANDBOXED = 'true';
    process.env.NODE_ENV = 'test';
    const service = new McpTestingService();
    expect((service as unknown as { allowUnsandboxed: boolean }).allowUnsandboxed).toBe(true);
  });

  it('leaves the escape hatch off when the flag is unset', () => {
    delete process.env.MCP_TESTING_ALLOW_UNSANDBOXED;
    process.env.NODE_ENV = 'test';
    const service = new McpTestingService();
    expect((service as unknown as { allowUnsandboxed: boolean }).allowUnsandboxed).toBe(false);
  });
});
