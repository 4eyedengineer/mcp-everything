import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ServiceUnavailableException } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { HostedMcpClientService } from './hosted-mcp-client.service';
import { McpUpstreamResolver } from './mcp-upstream-resolver.service';
import { HostedServer } from '../../database/entities/hosted-server.entity';

/**
 * These tests run against a REAL stateful Streamable HTTP MCP server
 * (SDK `McpServer` + `StreamableHTTPServerTransport` with a session id
 * generator, on an ephemeral loopback port), not a mocked transport.
 *
 * That is the whole point: every interesting behaviour of this service -
 * session reuse, session loss, reconnect - is a property of the MCP session
 * handshake, and a mocked `Client` would assert only that we call the methods
 * we call. The dispatch shape below (an outer `transports` map keyed by
 * `Mcp-Session-Id`, sessions created only on a real `initialize`) deliberately
 * mirrors the HTTP template every generated server is produced from, in
 * orchestration/refinement.service.ts.
 *
 * Tools are registered through the low-level `setRequestHandler` on the
 * underlying `Server` rather than `McpServer.registerTool` for one reason:
 * `registerTool` takes a Zod shape, and `zod` is not a declared dependency of
 * this package (it is only present transitively, hoisted from the MCP SDK).
 * From the client's side of the wire the two are indistinguishable, and this
 * way the exact JSON Schema the assertions check is written literally here.
 */
describe('HostedMcpClientService', () => {
  let httpServer: http.Server;
  let baseUrl: string;

  /** Live server-side sessions, keyed by Mcp-Session-Id. */
  const transports = new Map<string, StreamableHTTPServerTransport>();
  /** Every transport ever created, so afterEach can tear down orphans. */
  let createdTransports: StreamableHTTPServerTransport[] = [];

  let initializeCount = 0;
  let requestCount = 0;
  /** Requests seen per HTTP method, to prove no standalone GET SSE is opened. */
  let methodCounts: Record<string, number> = {};
  /** Status the test server uses for a session id it does not recognise. */
  let unknownSessionStatus = 404;
  // When true, every session is invalidated the instant it is created, so a
  // reconnect's initialize succeeds but its follow-up request cannot find the
  // session. Deterministic stand-in for "the pod keeps forgetting sessions" -
  // replaces a racy real-timer interval that could let a reconnect slip
  // through under load (flaked in CI).
  let dropSessionsImmediately = false;

  let service: HostedMcpClientService;
  let resolver: { resolve: jest.Mock };

  const runningServer = (overrides: Partial<HostedServer> = {}): HostedServer =>
    ({
      serverId: 'srv-test01',
      status: 'running',
      statusMessage: null,
      config: null,
      ...overrides,
    }) as unknown as HostedServer;

  function buildMcpServer(): McpServer {
    const mcp = new McpServer(
      { name: 'test-hosted-server', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );

    mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'echo',
          description: 'Echoes its arguments back',
          inputSchema: {
            type: 'object' as const,
            properties: { message: { type: 'string', description: 'Text to echo' } },
            required: ['message'],
          },
        },
        {
          name: 'always_fails',
          description: 'Always reports a tool-level failure',
          inputSchema: { type: 'object' as const, properties: {} },
        },
      ],
    }));

    mcp.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name !== 'echo' && request.params.name !== 'always_fails') {
        // A protocol-level failure, as distinct from the tool-level failure
        // below: the SDK turns this into a JSON-RPC error response.
        throw new Error(`Unknown tool: ${request.params.name}`);
      }

      if (request.params.name === 'always_fails') {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: 'upstream tool blew up' }],
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(request.params.arguments ?? {}),
          },
        ],
      };
    });

    return mcp;
  }

  beforeAll(async () => {
    httpServer = http.createServer(async (req, res) => {
      requestCount++;
      methodCounts[req.method ?? 'UNKNOWN'] = (methodCounts[req.method ?? 'UNKNOWN'] ?? 0) + 1;
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

      if (url.pathname !== '/mcp') {
        res.writeHead(404).end('not found');
        return;
      }

      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const raw = Buffer.concat(chunks).toString('utf-8');
        const body = raw.length > 0 ? JSON.parse(raw) : undefined;

        let transport: StreamableHTTPServerTransport;

        if (sessionId && transports.has(sessionId)) {
          transport = transports.get(sessionId)!;
        } else if (!sessionId && isInitializeRequest(body)) {
          initializeCount++;
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (newSessionId) => {
              transports.set(newSessionId, transport);
              if (dropSessionsImmediately) {
                // Session id is still returned to the client, but it resolves
                // to nothing on the next request - as if the pod restarted.
                transports.delete(newSessionId);
              }
            },
          });
          transport.onclose = () => {
            if (transport.sessionId) transports.delete(transport.sessionId);
          };
          createdTransports.push(transport);
          await buildMcpServer().connect(transport);
        } else {
          respondUnknownSession(res);
          return;
        }

        await transport.handleRequest(req, res, body);
        return;
      }

      if (req.method === 'GET' || req.method === 'DELETE') {
        if (!sessionId || !transports.has(sessionId)) {
          respondUnknownSession(res);
          return;
        }
        await transports.get(sessionId)!.handleRequest(req, res);
        return;
      }

      res.writeHead(405).end('method not allowed');
    });

    function respondUnknownSession(res: http.ServerResponse): void {
      res.writeHead(unknownSessionStatus, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: {
            code: -32001,
            message:
              unknownSessionStatus === 404
                ? 'Session not found'
                : 'Bad Request: no valid session ID provided for non-initialize request',
          },
          id: null,
        }),
      );
    }

    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const { port } = httpServer.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      httpServer.close((err) => (err ? reject(err) : resolve())),
    );
    // Keep-alive sockets from undici would otherwise outlive the server and
    // hold the Jest worker open.
    httpServer.closeAllConnections?.();
  });

  /**
   * @param idleMs when supplied, stands in for HOSTED_MCP_CLIENT_IDLE_MS
   */
  async function createService(idleMs?: number): Promise<HostedMcpClientService> {
    resolver = {
      resolve: jest.fn((server: HostedServer) => {
        if (server.status !== 'running') {
          throw new ServiceUnavailableException(
            `Hosted server '${server.serverId}' is not running (status: ${server.status}).`,
          );
        }
        return `${baseUrl}/mcp`;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HostedMcpClientService,
        { provide: McpUpstreamResolver, useValue: resolver },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, fallback?: unknown) =>
              key === 'HOSTED_MCP_CLIENT_IDLE_MS' && idleMs !== undefined ? idleMs : fallback,
            ),
          },
        },
      ],
    }).compile();

    return module.get(HostedMcpClientService);
  }

  beforeEach(async () => {
    initializeCount = 0;
    requestCount = 0;
    methodCounts = {};
    unknownSessionStatus = 404;
    dropSessionsImmediately = false;
    createdTransports = [];
    service = await createService();
  });

  afterEach(async () => {
    await service.onModuleDestroy();
    await Promise.all(
      createdTransports.map((transport) => transport.close().catch(() => undefined)),
    );
    transports.clear();
  });

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  describe('listTools', () => {
    it('returns the live tool set, including the raw JSON Schema', async () => {
      const tools = await service.listTools(runningServer());

      expect(tools.map((t) => t.name)).toEqual(['echo', 'always_fails']);
      expect(tools[0]).toEqual({
        name: 'echo',
        description: 'Echoes its arguments back',
        inputSchema: {
          type: 'object',
          properties: { message: { type: 'string', description: 'Text to echo' } },
          required: ['message'],
        },
      });
    });
  });

  describe('callTool', () => {
    it('round-trips arguments to the hosted server', async () => {
      const result = await service.callTool(runningServer(), 'echo', {
        message: 'hello',
        nested: { n: 1 },
      });

      expect(result.isError).toBeFalsy();
      const [content] = result.content as Array<{ type: string; text: string }>;
      expect(JSON.parse(content.text)).toEqual({ message: 'hello', nested: { n: 1 } });
    });

    it('returns a tool-level error rather than throwing', async () => {
      const result = await service.callTool(runningServer(), 'always_fails', {});

      expect(result.isError).toBe(true);
      expect((result.content as Array<{ text: string }>)[0].text).toContain('blew up');
    });

    it('still throws on a protocol error (unknown tool)', async () => {
      await expect(service.callTool(runningServer(), 'no_such_tool', {})).rejects.toThrow();
      // The session survives a plain protocol error - no reconnect.
      expect(initializeCount).toBe(1);
    });
  });

  describe('session lifecycle', () => {
    it('reuses one session across calls', async () => {
      await service.listTools(runningServer());
      await service.callTool(runningServer(), 'echo', { message: 'a' });
      await service.listTools(runningServer());

      expect(initializeCount).toBe(1);
    });

    it('does not open two sessions when first use is concurrent', async () => {
      await Promise.all([
        service.listTools(runningServer()),
        service.listTools(runningServer()),
        service.listTools(runningServer()),
      ]);

      expect(initializeCount).toBe(1);
    });

    it('opens a fresh session after invalidate', async () => {
      await service.listTools(runningServer());
      expect(initializeCount).toBe(1);

      await service.invalidate('srv-test01');
      await service.listTools(runningServer());

      expect(initializeCount).toBe(2);
    });

    it('invalidate is a no-op when nothing is cached', async () => {
      await expect(service.invalidate('srv-never-used')).resolves.toBeUndefined();
      expect(initializeCount).toBe(0);
    });

    it('evicts an idle session and reconnects on the next call', async () => {
      const shortLived = await createService(40);
      try {
        await shortLived.listTools(runningServer());
        expect(initializeCount).toBe(1);

        await sleep(150);

        await shortLived.listTools(runningServer());
        expect(initializeCount).toBe(2);
      } finally {
        await shortLived.onModuleDestroy();
      }
    });

    it('closes every session on module destroy', async () => {
      await service.listTools(runningServer());
      await service.onModuleDestroy();

      // The server-side session was explicitly terminated, so the map is empty
      // and the next call has to handshake again.
      expect(transports.size).toBe(0);
      await service.listTools(runningServer());
      expect(initializeCount).toBe(2);
    });
  });

  describe('resolver enforcement', () => {
    it('throws ServiceUnavailableException for a stopped server without touching the network', async () => {
      await expect(service.listTools(runningServer({ status: 'stopped' }))).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );

      expect(requestCount).toBe(0);
      expect(initializeCount).toBe(0);
    });

    it('refuses to use a cached session once the server stops', async () => {
      await service.listTools(runningServer());
      expect(initializeCount).toBe(1);
      const afterFirstCall = requestCount;

      await expect(
        service.callTool(runningServer({ status: 'stopped' }), 'echo', { message: 'x' }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);

      expect(requestCount).toBe(afterFirstCall);
    });

    it('never opens the standalone GET SSE stream', async () => {
      // The SDK client opens one automatically once `initialized` is accepted,
      // and this server would hold it open indefinitely. Nothing here consumes
      // server push, so the transport is fed a synthetic 405 instead - which
      // the SDK treats as an expected no-op, so there is no error, no
      // reconnection backoff and no permanently in-flight fetch.
      await service.listTools(runningServer());
      await service.callTool(runningServer(), 'echo', { message: 'x' });

      expect(methodCounts.POST).toBeGreaterThan(0);
      expect(methodCounts.GET).toBeUndefined();
    });

    it('re-resolves the upstream on every call', async () => {
      await service.listTools(runningServer());
      await service.listTools(runningServer());

      expect(resolver.resolve).toHaveBeenCalledTimes(2);
    });
  });

  describe('session-lost recovery', () => {
    it('reconnects exactly once when the server has forgotten the session (404)', async () => {
      await service.listTools(runningServer());
      expect(initializeCount).toBe(1);

      // Simulate the pod restarting underneath us: the session id the client
      // still holds no longer maps to anything server side.
      transports.clear();

      const result = await service.callTool(runningServer(), 'echo', { message: 'after restart' });

      expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toEqual({
        message: 'after restart',
      });
      expect(initializeCount).toBe(2);
    });

    it('reconnects once when the server answers 400 for an unknown session, as generated servers do', async () => {
      unknownSessionStatus = 400;

      await service.listTools(runningServer());
      expect(initializeCount).toBe(1);

      transports.clear();

      const tools = await service.listTools(runningServer());

      expect(tools.map((t) => t.name)).toEqual(['echo', 'always_fails']);
      expect(initializeCount).toBe(2);
    });

    it('gives up after a single reconnect attempt', async () => {
      await service.listTools(runningServer());
      expect(initializeCount).toBe(1);

      // Every subsequent session is dropped the moment it is created, so the
      // retry cannot succeed either. Deterministic (see dropSessionsImmediately)
      // rather than racing a real timer against the reconnect.
      transports.clear();
      dropSessionsImmediately = true;

      await expect(service.listTools(runningServer())).rejects.toThrow();

      // One original + exactly one reconnect.
      expect(initializeCount).toBe(2);
    });
  });
});
