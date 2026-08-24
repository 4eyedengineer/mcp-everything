import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { McpTestingService, GeneratedCode } from './mcp-testing.service';
import type { K8sTestSandboxService, TestSandboxHandle } from './k8s-test-sandbox.service';

/**
 * Exercises the Kubernetes test-pod path of McpTestingService.
 *
 * The k8s CLIENT boundary is mocked (there is no cluster in CI), but the MCP
 * handshake is driven against a REAL in-process stateful Streamable HTTP
 * server (SDK McpServer + StreamableHTTPServerTransport with a session id
 * generator, on an ephemeral loopback port) — the mocked sandbox's
 * serviceBaseUrl() simply points the client at that server. That proves the
 * k8s path really performs initialize -> notifications/initialized ->
 * tools/list -> tools/call and fills the McpServerTestResult exactly like the
 * Docker path, rather than just asserting method calls.
 */
describe('McpTestingService — Kubernetes test-pod path', () => {
  let httpServer: http.Server;
  let baseUrl: string;
  const transports = new Map<string, StreamableHTTPServerTransport>();
  let createdTransports: StreamableHTTPServerTransport[] = [];

  const originalSandboxEnv = process.env.MCP_TESTING_SANDBOX;

  /** A generated server exposing one passing tool (echo) and one failing (broken). */
  const GENERATED: GeneratedCode = {
    mainFile: '// not compiled in this test; the in-process server stands in for it',
    packageJson: '{"name":"gen","version":"1.0.0"}',
    tsConfig: '{}',
    supportingFiles: {},
    metadata: {
      iteration: 1,
      serverName: 'gen-server',
      tools: [
        {
          name: 'echo',
          description: 'Echoes its message',
          inputSchema: {
            type: 'object',
            properties: { message: { type: 'string' } },
            required: ['message'],
          },
        },
        {
          name: 'broken',
          description: 'Always errors at the protocol level',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    },
  };

  function buildMcpServer(): McpServer {
    const mcp = new McpServer(
      { name: 'gen-server', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'echo',
          description: 'Echoes its message',
          inputSchema: { type: 'object' as const, properties: { message: { type: 'string' } } },
        },
        {
          name: 'broken',
          description: 'Always errors at the protocol level',
          inputSchema: { type: 'object' as const, properties: {} },
        },
      ],
    }));
    mcp.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name === 'echo') {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(request.params.arguments ?? {}) }],
        };
      }
      // Protocol-level failure -> JSON-RPC error response, which
      // testMcpToolDirect must count as a failing tool.
      throw new Error('broken tool always fails');
    });
    return mcp;
  }

  beforeAll(async () => {
    httpServer = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

      if (url.pathname === '/health') {
        res.writeHead(200).end('ok');
        return;
      }
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
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
              transports.set(id, transport);
            },
          });
          transport.onclose = () => {
            if (transport.sessionId) transports.delete(transport.sessionId);
          };
          createdTransports.push(transport);
          await buildMcpServer().connect(transport);
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' }).end(
            JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'no session' }, id: null }),
          );
          return;
        }
        await transport.handleRequest(req, res, body);
        return;
      }
      res.writeHead(405).end('method not allowed');
    });

    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const { port } = httpServer.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    for (const t of createdTransports) {
      try {
        await t.close();
      } catch {
        /* ignore */
      }
    }
    await new Promise<void>((resolve, reject) =>
      httpServer.close((err) => (err ? reject(err) : resolve())),
    );
    httpServer.closeAllConnections?.();
  });

  afterEach(() => {
    if (originalSandboxEnv === undefined) delete process.env.MCP_TESTING_SANDBOX;
    else process.env.MCP_TESTING_SANDBOX = originalSandboxEnv;
  });

  /** A mocked K8sTestSandboxService whose service URL points at the real in-process server. */
  function mockSandbox(overrides: Partial<K8sTestSandboxService> = {}): {
    sandbox: jest.Mocked<Pick<K8sTestSandboxService, 'isEnabled' | 'createSandbox' | 'waitForSandboxReady' | 'serviceBaseUrl' | 'destroySandbox'>> & {
      testImage: string;
    };
  } {
    const handle: TestSandboxHandle = { name: 'mcptest-deadbeef', testId: 't' };
    const sandbox = {
      testImage: 'node:20-alpine',
      isEnabled: jest.fn().mockReturnValue(true),
      createSandbox: jest.fn().mockResolvedValue(handle),
      waitForSandboxReady: jest.fn().mockResolvedValue({ ready: true, buildSucceeded: true }),
      serviceBaseUrl: jest.fn().mockReturnValue(baseUrl),
      destroySandbox: jest.fn().mockResolvedValue([]),
      ...overrides,
    } as unknown as jest.Mocked<
      Pick<K8sTestSandboxService, 'isEnabled' | 'createSandbox' | 'waitForSandboxReady' | 'serviceBaseUrl' | 'destroySandbox'>
    > & { testImage: string };
    return { sandbox };
  }

  it('drives the real MCP handshake against the test pod and fills the standard result shape', async () => {
    process.env.MCP_TESTING_SANDBOX = 'k8s';
    const { sandbox } = mockSandbox();
    const service = new McpTestingService(sandbox as unknown as K8sTestSandboxService);

    const result = await service.testMcpServer(GENERATED, { timeout: 30, toolTimeout: 5 });

    // Same contract the Docker path returns and RefinementService consumes.
    expect(result.buildSuccess).toBe(true);
    expect(result.imageTag).toBe('node:20-alpine');
    expect(result.containerId).toBe('mcptest-deadbeef');
    expect(result.toolsFound).toBe(2);
    expect(result.toolsTested).toBe(2);
    expect(result.toolsPassedCount).toBe(1); // echo passes, broken fails
    expect(result.overallSuccess).toBe(false);
    expect(result.results.map((r) => r.toolName).sort()).toEqual(['broken', 'echo']);
    expect(result.results.find((r) => r.toolName === 'echo')!.success).toBe(true);
    expect(result.results.find((r) => r.toolName === 'broken')!.success).toBe(false);

    // Real orchestration happened.
    expect(sandbox.createSandbox).toHaveBeenCalledTimes(1);
    // Source shipped in the Secret in the on-disk layout the Docker path uses.
    const created = sandbox.createSandbox.mock.calls[0][0];
    expect(created.files['src/index.ts']).toBe(GENERATED.mainFile);
    expect(created.files['package.json']).toBe(GENERATED.packageJson);

    // Sandbox torn down.
    expect(sandbox.destroySandbox).toHaveBeenCalledTimes(1);
    expect(result.cleanupSuccess).toBe(true);
  });

  it('tears the sandbox down even when readiness/handshake throws', async () => {
    process.env.MCP_TESTING_SANDBOX = 'k8s';
    const { sandbox } = mockSandbox({
      waitForSandboxReady: jest.fn().mockRejectedValue(new Error('cluster hiccup')) as never,
    });
    const service = new McpTestingService(sandbox as unknown as K8sTestSandboxService);

    const result = await service.testMcpServer(GENERATED, { timeout: 5, toolTimeout: 2 });

    expect(result.overallSuccess).toBe(false);
    expect(result.buildError).toContain('cluster hiccup');
    expect(sandbox.destroySandbox).toHaveBeenCalledTimes(1);
  });

  it('surfaces a build failure from the pod as buildSuccess=false with no tools tested', async () => {
    process.env.MCP_TESTING_SANDBOX = 'k8s';
    const { sandbox } = mockSandbox({
      waitForSandboxReady: jest
        .fn()
        .mockResolvedValue({ ready: false, buildSucceeded: false, error: 'error TS2304' }) as never,
    });
    const service = new McpTestingService(sandbox as unknown as K8sTestSandboxService);

    const result = await service.testMcpServer(GENERATED, { timeout: 5, toolTimeout: 2 });

    expect(result.buildSuccess).toBe(false);
    expect(result.buildError).toContain('TS2304');
    expect(result.toolsTested).toBe(0);
    expect(result.overallSuccess).toBe(false);
    expect(sandbox.destroySandbox).toHaveBeenCalledTimes(1);
  });
});

/**
 * Pure selection-logic tests: which sandbox backend testMcpServer picks. The
 * two backend entry points (ensureDockerAvailable for Docker, testMcpServerOnK8s
 * for the cluster) are spied so no real Docker build or cluster call happens —
 * we assert only which branch is taken.
 */
describe('McpTestingService — sandbox backend selection', () => {
  const originalSandboxEnv = process.env.MCP_TESTING_SANDBOX;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalAllow = process.env.MCP_TESTING_ALLOW_UNSANDBOXED;

  const enabledSandbox = () =>
    ({ isEnabled: () => true, testImage: 'node:20-alpine' }) as unknown as K8sTestSandboxService;
  const disabledSandbox = () =>
    ({ isEnabled: () => false, testImage: 'node:20-alpine' }) as unknown as K8sTestSandboxService;

  const DUMMY: GeneratedCode = {
    mainFile: '',
    packageJson: '{}',
    tsConfig: '{}',
    supportingFiles: {},
    metadata: { iteration: 1, serverName: 's', tools: [] },
  };

  afterEach(() => {
    if (originalSandboxEnv === undefined) delete process.env.MCP_TESTING_SANDBOX;
    else process.env.MCP_TESTING_SANDBOX = originalSandboxEnv;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalAllow === undefined) delete process.env.MCP_TESTING_ALLOW_UNSANDBOXED;
    else process.env.MCP_TESTING_ALLOW_UNSANDBOXED = originalAllow;
    jest.restoreAllMocks();
  });

  it('auto + Docker reachable -> Docker path (k8s not chosen even when configured)', async () => {
    process.env.MCP_TESTING_SANDBOX = 'auto';
    const service = new McpTestingService(enabledSandbox());
    jest.spyOn(service as never, 'isDockerReachable').mockResolvedValue(true as never);
    const k8sSpy = jest.spyOn(service as never, 'testMcpServerOnK8s');
    // Stand in for the Docker path entry so no real build runs.
    jest
      .spyOn(service as never, 'ensureDockerAvailable')
      .mockRejectedValue(new Error('DOCKER_PATH_ENTERED') as never);

    await expect(service.testMcpServer(DUMMY)).rejects.toThrow('DOCKER_PATH_ENTERED');
    expect(k8sSpy).not.toHaveBeenCalled();
  });

  it('auto + Docker unreachable + k8s enabled -> Kubernetes path', async () => {
    process.env.MCP_TESTING_SANDBOX = 'auto';
    const service = new McpTestingService(enabledSandbox());
    jest.spyOn(service as never, 'isDockerReachable').mockResolvedValue(false as never);
    const k8sSpy = jest
      .spyOn(service as never, 'testMcpServerOnK8s')
      .mockResolvedValue({ overallSuccess: true } as never);

    const result = await service.testMcpServer(DUMMY);
    expect(k8sSpy).toHaveBeenCalledTimes(1);
    expect((result as { overallSuccess: boolean }).overallSuccess).toBe(true);
  });

  it('mode=k8s -> Kubernetes path without probing Docker at all', async () => {
    process.env.MCP_TESTING_SANDBOX = 'k8s';
    const service = new McpTestingService(enabledSandbox());
    const dockerSpy = jest.spyOn(service as never, 'isDockerReachable');
    const k8sSpy = jest
      .spyOn(service as never, 'testMcpServerOnK8s')
      .mockResolvedValue({ overallSuccess: true } as never);

    await service.testMcpServer(DUMMY);
    expect(k8sSpy).toHaveBeenCalledTimes(1);
    expect(dockerSpy).not.toHaveBeenCalled();
  });

  it('mode=k8s but no cluster -> fails closed (never Docker, never host)', async () => {
    process.env.MCP_TESTING_SANDBOX = 'k8s';
    const service = new McpTestingService(disabledSandbox());
    const dockerSpy = jest.spyOn(service as never, 'ensureDockerAvailable');

    await expect(service.testMcpServer(DUMMY)).rejects.toThrow(/no Kubernetes test sandbox is reachable/);
    expect(dockerSpy).not.toHaveBeenCalled();
  });

  it('no k8s + Docker unavailable + production -> still fails closed (unchanged invariant)', async () => {
    process.env.MCP_TESTING_SANDBOX = 'auto';
    process.env.NODE_ENV = 'production';
    process.env.MCP_TESTING_ALLOW_UNSANDBOXED = 'true'; // must be ignored in prod
    const service = new McpTestingService(); // no sandbox provided
    // Force the cached "docker unavailable" verdict without shelling out.
    (service as unknown as { dockerAvailable: boolean }).dockerAvailable = false;

    await expect(service.testMcpServer(DUMMY)).rejects.toThrow(/Docker is required/);
  });
});
