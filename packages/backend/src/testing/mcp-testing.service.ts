import { Injectable, Logger, Optional, OnModuleDestroy } from '@nestjs/common';
import { spawn, exec } from 'child_process';
import { K8sTestSandboxService, TestSandboxHandle } from './k8s-test-sandbox.service';
import { promisify } from 'util';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import * as os from 'os';
import * as net from 'net';
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
  /**
   * True when this result represents a test-INFRASTRUCTURE failure (the
   * sandbox/test harness itself failed to provision or run the generated
   * server — e.g. a Kubernetes test-pod Secret/Deployment/Service create
   * failing, or a mid-flight readiness-poll error) rather than a genuine test
   * RESULT (the server ran and some/all tools failed). buildError/results are
   * still populated for logging/display, but callers driving a generate-fix-
   * retest loop (see RefinementService.refineUntilWorking) MUST NOT treat
   * this as evidence the generated code is broken: the code was never
   * actually exercised. Omitted/false for every other outcome, including
   * genuine build failures (e.g. a TypeScript compile error in the generated
   * code), which remain real, actionable test RESULTS.
   */
  infrastructureFailure?: boolean;
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
 * Which wire transport to speak to the MCP server under test.
 *
 * - 'stdio': newline-delimited JSON-RPC over the child process's stdin/stdout.
 *   This is the original, still-supported transport.
 * - 'http': MCP Streamable HTTP — `POST /mcp` (JSON-RPC request/response,
 *   SSE-framed) plus `GET /health`. This is the transport generated servers
 *   are actually hosted over, so it is the default for the refine/validation
 *   loop (see `DEFAULT_TRANSPORT` below).
 */
export type McpTransportMode = 'stdio' | 'http';

/**
 * Default transport used when a caller doesn't explicitly pick one. HTTP is
 * the transport generated servers are actually deployed/hosted over, so the
 * quality-gate loop (McpTestingService + McpProtocolValidatorService) now
 * exercises that path by default. Set `transport: 'stdio'` explicitly to opt
 * back into the legacy stdio-only path (e.g. for servers/fixtures that don't
 * implement `MCP_TRANSPORT=http`).
 */
export const DEFAULT_MCP_TRANSPORT: McpTransportMode = 'http';

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
  /** Wire transport to test over. Defaults to `DEFAULT_MCP_TRANSPORT` ('http'). */
  transport?: McpTransportMode;
}

/**
 * MCP Protocol test message
 */
export interface McpMessage {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: any;
}

/**
 * MCP Protocol response
 */
export interface McpResponse {
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
 * Ask the OS for an ephemeral, currently-unused TCP port by binding to port 0
 * and reading back the port the kernel assigned, then immediately releasing
 * it. There is an inherent (tiny) TOCTOU race between releasing the port here
 * and the MCP server binding it, but this is the same best-effort approach
 * used by e.g. the `get-port` package and is more than adequate for
 * short-lived test/validation servers.
 */
export async function allocateFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const { port } = address;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Failed to allocate a free TCP port')));
      }
    });
  });
}

/**
 * Client for the MCP Streamable HTTP transport
 * (`StreamableHTTPServerTransport` in `@modelcontextprotocol/sdk`). This is
 * the ONE place the HTTP handshake is implemented — both McpTestingService
 * (Docker-sandboxed and unsandboxed) and McpProtocolValidatorService import
 * and reuse this class rather than each re-implementing it.
 *
 * Empirically-confirmed protocol details this class handles (verified
 * against a real StreamableHTTPServerTransport server):
 *  - Every request MUST send `Accept: application/json, text/event-stream`.
 *    Omitting the `text/event-stream` half of that header causes the server
 *    to respond `406 Not Acceptable`.
 *  - On a successful `initialize` call, the server returns an
 *    `Mcp-Session-Id` response header. Every subsequent request for that
 *    session must echo it back as a request header, or the server responds
 *    `400 Bad Request`.
 *  - Responses are SSE-framed (`event: message\ndata: {...}\n\n`), not plain
 *    JSON, even though the request body is plain JSON-RPC.
 *  - Fire-and-forget notifications (e.g. `notifications/initialized`) get a
 *    bare `202 Accepted` with no body.
 */
export class McpHttpTransportClient {
  constructor(private readonly baseUrl: string) {}

  /** Mcp-Session-Id captured from the `initialize` response, if any. */
  private sessionId: string | undefined;

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      // Both halves are required — the server 406s if either is missing.
      Accept: 'application/json, text/event-stream',
    };
    if (this.sessionId) {
      headers['Mcp-Session-Id'] = this.sessionId;
    }
    return headers;
  }

  /**
   * One-shot, non-throwing health probe. Used by `waitForServerReady` to
   * poll `GET /health` in place of the stdio transport's `stdin.writable`
   * check.
   */
  async isHealthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(1000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Send a JSON-RPC request expecting a response (initialize, tools/list,
   * tools/call, ...) and return the parsed `McpResponse`.
   */
  async send(message: McpMessage, timeoutMs: number): Promise<McpResponse> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/mcp`, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new Error(
        `MCP HTTP request failed (network/timeout): ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const newSessionId = res.headers.get('mcp-session-id');
    if (newSessionId) {
      this.sessionId = newSessionId;
    }

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      throw new Error(
        `MCP HTTP request failed: ${res.status} ${res.statusText}${bodyText ? ` — ${bodyText.slice(0, 300)}` : ''}`,
      );
    }

    const bodyText = await res.text();
    const contentType = res.headers.get('content-type') || '';

    if (contentType.includes('text/event-stream')) {
      return this.parseSseBody(bodyText);
    }

    // Some transports may reply with plain JSON for simple requests; support
    // that too rather than assuming SSE unconditionally.
    return JSON.parse(bodyText);
  }

  /**
   * Send a fire-and-forget JSON-RPC notification (no `id`, no response body
   * expected beyond a bare `202 Accepted`).
   */
  async notify(method: string, timeoutMs = 5000): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/mcp`, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify({ jsonrpc: '2.0', method }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new Error(
        `MCP HTTP notification failed (network/timeout): ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!res.ok && res.status !== 202) {
      const bodyText = await res.text().catch(() => '');
      throw new Error(
        `MCP HTTP notification failed: ${res.status} ${res.statusText}${bodyText ? ` — ${bodyText.slice(0, 300)}` : ''}`,
      );
    }
  }

  /** Parse an `event: message\ndata: {...}` SSE-framed response body. */
  private parseSseBody(body: string): McpResponse {
    for (const line of body.split('\n')) {
      if (line.startsWith('data:')) {
        const jsonStr = line.slice('data:'.length).trim();
        if (jsonStr) {
          return JSON.parse(jsonStr);
        }
      }
    }
    throw new Error(`No "data:" line found in SSE response body: ${body.slice(0, 300)}`);
  }
}

/**
 * Env var that re-enables the legacy, UNSANDBOXED host-execution path when
 * Docker is unavailable. Intended only for ephemeral CI runners without
 * Docker-in-Docker; never set this in a shared, dev, or production
 * environment, since it runs LLM-generated code directly as this process's
 * user with full access to this process's environment variables (API keys,
 * DB credentials, etc.) and filesystem.
 */
const ALLOW_UNSANDBOXED_ENV_VAR = 'MCP_TESTING_ALLOW_UNSANDBOXED';

/**
 * Which sandbox backend runs untrusted, LLM-generated MCP servers during the
 * generate-test-refine loop. Chosen via MCP_TESTING_SANDBOX (see
 * `resolveSandboxMode`):
 *
 *  - 'docker': only ever use the local Docker daemon; if it is unavailable,
 *    fail closed (unchanged legacy behaviour).
 *  - 'k8s':    only ever use the Kubernetes test-pod sandbox; if no cluster is
 *    reachable, fail closed. Intended for in-cluster deployments where the
 *    backend pod has no Docker daemon.
 *  - 'auto' (default): prefer Docker when its daemon is reachable (fast local
 *    path); otherwise, if a Kubernetes sandbox is configured, use it; otherwise
 *    fall through to the existing Docker-required / fail-closed behaviour. This
 *    means the k8s path only ever engages when a cluster is genuinely reachable
 *    and Docker is not — never as a silent default in local dev or CI.
 */
export type SandboxMode = 'docker' | 'k8s' | 'auto';

/** Env var selecting the sandbox backend. */
const SANDBOX_MODE_ENV_VAR = 'MCP_TESTING_SANDBOX';

/**
 * MCP server testing service.
 *
 * SECURITY MODEL: LLM-generated code is untrusted. Every step that executes
 * it — `npm install`, `tsc` compilation, and running the built MCP server —
 * happens inside a disposable, resource-limited Docker container:
 *   - No host environment variables are ever passed into the containers, so
 *     generated code cannot read ANTHROPIC_API_KEY / GITHUB_TOKEN / DB
 *     credentials / etc. even if it tries to exfiltrate `process.env`.
 *   - `npm install` runs with `--ignore-scripts` to block malicious
 *     pre/postinstall payloads, and with CPU/memory/pids limits.
 *   - `tsc` compilation runs with `--network=none` (no network needed).
 *   - The server-under-test runs with `--network=<config.networkMode>`
 *     (defaults to 'bridge' so tools can call real external APIs, but callers
 *     such as the refinement loop can force `'none'`), `--read-only` root
 *     filesystem with a `tmpfs` scratch dir, and the same CPU/memory/pids
 *     limits.
 *
 * TRANSPORT: generated servers speak both MCP transports, selected via
 * `MCP_TRANSPORT` (`stdio` default in the generated server, `http` when this
 * service starts it for testing — see `DEFAULT_MCP_TRANSPORT`):
 *   - `stdio` (opt-in via `config.transport = 'stdio'`): newline-delimited
 *     JSON-RPC over the child process's stdin/stdout, tunneled through
 *     `docker run -i` when sandboxed.
 *   - `http` (default): the server is started with `-e MCP_TRANSPORT=http`
 *     and a published port, and this service speaks MCP Streamable HTTP
 *     (`POST /mcp`, `GET /health`) to it via `McpHttpTransportClient`. This
 *     is the transport generated servers are actually hosted over, so it is
 *     the one exercised by default in the refine/quality-gate loop.
 *
 * Docker is a hard dependency for this service. If the Docker daemon is not
 * reachable, `testMcpServer` fails loudly instead of silently falling back to
 * running untrusted code on the host. Set
 * `MCP_TESTING_ALLOW_UNSANDBOXED=true` to explicitly opt back into the old
 * unsandboxed host-execution path (logs a prominent warning every time it is
 * used) — intended only for CI environments that genuinely cannot run
 * Docker-in-Docker. That flag is hard-disabled under NODE_ENV=production: in
 * production the service always fails closed rather than run untrusted code on
 * the host, no matter what the environment says.
 */
@Injectable()
export class McpTestingService implements OnModuleDestroy {
  private readonly logger = new Logger(McpTestingService.name);
  private readonly tempBaseDir = join(os.tmpdir(), 'mcp-testing');
  private readonly defaultConfig: McpTestConfig = {
    cpuLimit: '0.5',
    memoryLimit: '512m',
    timeout: 120, // 2 minutes for entire test
    toolTimeout: 10, // 10 seconds per tool (increased for real execution)
    networkMode: 'bridge', // Allow network for API calls
    cleanup: true,
    transport: DEFAULT_MCP_TRANSPORT,
  };

  /** Base image used to run untrusted install/compile/execute steps. */
  private readonly dockerImage = process.env.MCP_TESTING_DOCKER_IMAGE || 'node:20-alpine';

  /**
   * Escape hatch for Docker-less CI environments. See module doc comment.
   *
   * Hard-disabled under NODE_ENV=production regardless of the env var: running
   * untrusted, LLM-generated code on the host would expose this process's
   * secrets (ANTHROPIC_API_KEY, GITHUB_TOKEN, database credentials, JWT_SECRET)
   * and is only ever acceptable in an ephemeral CI runner. Defence in depth so
   * a stray `MCP_TESTING_ALLOW_UNSANDBOXED=true` in a production overlay cannot
   * silently re-arm host execution; the config line is the first line of
   * defence, this is the second.
   */
  private readonly allowUnsandboxed =
    process.env[ALLOW_UNSANDBOXED_ENV_VAR] === 'true' && process.env.NODE_ENV !== 'production';

  /** Cached result of the one-time Docker availability probe. */
  private dockerAvailable: boolean | null = null;

  private progressCallbacks: Map<string, (update: TestProgressUpdate) => void> = new Map();
  private runningProcesses: Map<string, any> = new Map(); // Track spawned MCP server processes (host child or `docker run -i` client)

  /**
   * Names of currently-live Docker containers spawned by this service,
   * tracked independently of `runningProcesses` so that install/build-step
   * containers (which are awaited synchronously and never touch
   * `runningProcesses`) are also cleaned up on timeout or process shutdown.
   * `--rm` is passed to every `docker run`, so killing/stopping the
   * container by name is sufficient to guarantee no orphans are left behind.
   */
  private readonly activeContainerNames: Set<string> = new Set();

  /**
   * Optional Kubernetes test-pod sandbox. Present only when TestingModule
   * provides it (it depends only on ConfigService, so no HostingModule import
   * and no DI cycle). `@Optional()` keeps `new McpTestingService()` working for
   * the existing unit tests and for any consumer that never touches k8s.
   */
  constructor(@Optional() private readonly k8sSandbox?: K8sTestSandboxService) {
    // Ensure temp directory exists
    if (!existsSync(this.tempBaseDir)) {
      mkdirSync(this.tempBaseDir, { recursive: true });
    }

    // Surface the ignored escape hatch loudly: without this, an operator who
    // set the flag in a production overlay would see generation fail with a
    // generic "Docker required" error and no hint that their flag was the
    // thing being refused.
    if (
      process.env[ALLOW_UNSANDBOXED_ENV_VAR] === 'true' &&
      process.env.NODE_ENV === 'production'
    ) {
      this.logger.warn(
        `${ALLOW_UNSANDBOXED_ENV_VAR}=true is set but IGNORED because NODE_ENV=production. ` +
          'Unsandboxed host execution of LLM-generated code is never permitted in production. ' +
          'Provide a real Docker sandbox instead; testing will fail closed until one is available.',
      );
    }
  }

  /**
   * Best-effort cleanup of any containers still tracked when the Nest
   * application shuts down (e.g. process restart mid-test). Every container
   * is started with `--rm`, so a successful `docker kill`/`docker stop`
   * removes it immediately.
   */
  async onModuleDestroy(): Promise<void> {
    const names = Array.from(this.activeContainerNames);
    if (names.length === 0) return;

    this.logger.warn(
      `Shutting down with ${names.length} tracked test container(s) still active; force-stopping: ${names.join(', ')}`,
    );

    await Promise.all(names.map((name) => this.stopContainer(name)));
  }

  /**
   * Verify the Docker daemon is reachable. The result is cached for the
   * lifetime of this service instance (checked once, per the security
   * requirement that we never silently fall back to host execution on a
   * per-call basis).
   *
   * @throws if Docker is unavailable and MCP_TESTING_ALLOW_UNSANDBOXED is not 'true'
   */
  private async ensureDockerAvailable(): Promise<void> {
    if (this.dockerAvailable !== null) {
      if (!this.dockerAvailable && !this.allowUnsandboxed) {
        throw new Error(this.dockerUnavailableMessage());
      }
      return;
    }

    try {
      await execAsync('docker version --format "{{.Server.Version}}"', { timeout: 10000 });
      this.dockerAvailable = true;
      this.logger.log(
        'Docker sandbox verified (docker daemon reachable). MCP server testing will run in isolated containers.',
      );
    } catch (error) {
      this.dockerAvailable = false;
      const errMsg = error instanceof Error ? error.message : String(error);

      if (this.allowUnsandboxed) {
        this.logger.warn(
          `!!! SECURITY WARNING !!! Docker is unavailable (${errMsg}) and ${ALLOW_UNSANDBOXED_ENV_VAR}=true is set. ` +
            'Falling back to UNSANDBOXED host execution of LLM-generated code. Generated code will run as this ' +
            "process's user with full access to this process's environment variables (ANTHROPIC_API_KEY, " +
            'GITHUB_TOKEN, database credentials, etc.) and filesystem. This escape hatch must ONLY be used in ' +
            'ephemeral CI runners, never in shared, dev, or production environments.',
        );
        return;
      }

      throw new Error(this.dockerUnavailableMessage(errMsg));
    }
  }

  private dockerUnavailableMessage(errMsg?: string): string {
    return (
      `Docker is required to sandbox MCP server testing but is unavailable${errMsg ? ` (${errMsg})` : ''}. ` +
      'Refusing to execute untrusted LLM-generated code directly on the host. Install/start Docker, or set ' +
      `${ALLOW_UNSANDBOXED_ENV_VAR}=true to explicitly opt into unsandboxed host execution (not recommended ` +
      'outside of ephemeral CI environments without Docker-in-Docker support).'
    );
  }

  /**
   * Resolve the configured sandbox backend from MCP_TESTING_SANDBOX. Read from
   * process.env directly for consistency with the rest of this service, which
   * reads its flags the same way. Unknown values fall back to 'auto'.
   */
  private resolveSandboxMode(): SandboxMode {
    const raw = (process.env[SANDBOX_MODE_ENV_VAR] || 'auto').toLowerCase();
    if (raw === 'docker' || raw === 'k8s' || raw === 'auto') {
      return raw;
    }
    this.logger.warn(
      `Unrecognised ${SANDBOX_MODE_ENV_VAR}='${raw}'; defaulting to 'auto' (Docker if reachable, else Kubernetes if configured, else fail closed).`,
    );
    return 'auto';
  }

  /**
   * Non-throwing Docker availability probe, used only for the k8s-vs-docker
   * decision. Shares `this.dockerAvailable` with `ensureDockerAvailable()` so
   * the daemon is probed at most once; when it succeeds here the subsequent
   * `ensureDockerAvailable()` call takes its cached branch and does not
   * re-probe or re-log.
   */
  private async isDockerReachable(): Promise<boolean> {
    if (this.dockerAvailable !== null) {
      return this.dockerAvailable;
    }
    try {
      await execAsync('docker version --format "{{.Server.Version}}"', { timeout: 10000 });
      this.dockerAvailable = true;
      this.logger.log(
        'Docker sandbox verified (docker daemon reachable). MCP server testing will run in isolated containers.',
      );
    } catch {
      this.dockerAvailable = false;
    }
    return this.dockerAvailable;
  }

  private k8sSandboxUnavailableMessage(): string {
    return (
      `${SANDBOX_MODE_ENV_VAR}=k8s was requested but no Kubernetes test sandbox is reachable ` +
      '(no usable kubeconfig / in-cluster config). Refusing to run untrusted, LLM-generated code ' +
      'without an isolated sandbox. Point the backend at a cluster, or use ' +
      `${SANDBOX_MODE_ENV_VAR}=auto with a Docker daemon available.`
    );
  }

  /**
   * Flatten a GeneratedCode into the same on-disk layout `createTempServerDir`
   * produces (mainFile -> src/index.ts, package.json/tsconfig.json at the root,
   * supportingFiles at their own paths), as a plain path -> content map that
   * ships into the k8s test pod via a Secret.
   */
  private layoutFiles(generatedCode: GeneratedCode): Record<string, string> {
    return {
      'src/index.ts': generatedCode.mainFile,
      'package.json': generatedCode.packageJson,
      'tsconfig.json': generatedCode.tsConfig,
      ...generatedCode.supportingFiles,
    };
  }

  /**
   * Kubernetes test-pod path. Runs the untrusted server in an isolated pod
   * (Secret + Deployment + ClusterIP Service, all hardened; see
   * K8sTestSandboxService), waits for it to serve, then drives the exact same
   * MCP handshake + per-tool loop the Docker/HTTP path uses — reusing
   * `McpHttpTransportClient` via a synthetic `runningProcesses` entry so the
   * handshake code is shared, not duplicated. The sandbox is always torn down,
   * even on failure/timeout. Returns the identical `McpServerTestResult` shape
   * the Docker path returns.
   */
  private async testMcpServerOnK8s(
    generatedCode: GeneratedCode,
    config: McpTestConfig,
    testId: string,
    startTime: number,
  ): Promise<McpServerTestResult> {
    const sandbox = this.k8sSandbox!;
    const tools = generatedCode.metadata.tools;
    const toolTimeout = config.toolTimeout || 10;
    const totalTimeoutMs = (config.timeout || 120) * 1000;
    const imageTag = sandbox.testImage;

    let handle: TestSandboxHandle | null = null;
    let buildSuccess = false;
    let buildError: string | undefined;
    let buildDuration = 0;
    const results: ToolTestResult[] = [];
    let cleanupErrors: string[] = [];
    // Set only by the outer catch below, i.e. only when the test HARNESS
    // itself failed (e.g. the Secret/Deployment/Service create, or the
    // readiness poll, threw) before any tool ever ran. A genuine code/build
    // failure (readiness resolving with ready:false, e.g. a tsc error) is a
    // real test RESULT and must NOT set this.
    let infrastructureFailure = false;

    try {
      const buildStart = Date.now();

      this.streamProgress(testId, {
        type: 'building',
        message: 'Provisioning isolated Kubernetes test pod...',
        timestamp: new Date(),
      });

      handle = await sandbox.createSandbox({
        testId,
        files: this.layoutFiles(generatedCode),
        resources: { cpuLimit: config.cpuLimit, memoryLimit: config.memoryLimit },
      });

      const readiness = await sandbox.waitForSandboxReady(handle, totalTimeoutMs);
      buildDuration = Date.now() - buildStart;
      buildSuccess = readiness.buildSucceeded;

      if (!readiness.ready) {
        buildError = readiness.error;
        this.streamProgress(testId, {
          type: 'error',
          message: `Test pod never became ready: ${readiness.error}`,
          timestamp: new Date(),
        });
        this.logger.warn(`[${testId}] k8s test pod not ready: ${readiness.error}`);
      } else {
        // Drive the handshake over the Service using the shared HTTP client.
        // A synthetic runningProcesses entry lets initializeMcpServer /
        // getToolsList / testMcpToolDirect run unchanged — the HTTP branch of
        // each only ever touches processInfo.httpClient and stderrBuffer.
        const baseUrl = sandbox.serviceBaseUrl(handle);
        this.runningProcesses.set(testId, {
          transport: 'http',
          httpClient: new McpHttpTransportClient(baseUrl),
          pendingResponses: new Map(),
          buffer: '',
          stderrBuffer: '',
          ready: false,
        });

        this.streamProgress(testId, {
          type: 'testing',
          message: `Testing ${tools.length} tools against the test pod...`,
          timestamp: new Date(),
        });

        const initResult = await this.initializeMcpServer(testId, toolTimeout);
        if (!initResult.success) {
          this.logger.warn(`[${testId}] initialize failed on k8s test pod: ${initResult.error}`);
        }

        const toolsListResult = await this.getToolsList(testId, toolTimeout);
        const serverTools = toolsListResult.tools || [];
        this.logger.log(`[${testId}] k8s test pod reports ${serverTools.length} tools`);

        for (let i = 0; i < tools.length; i++) {
          const tool = tools[i];
          this.streamProgress(testId, {
            type: 'testing_tool',
            message: `Testing tool: ${tool.name}`,
            toolName: tool.name,
            toolIndex: i + 1,
            totalTools: tools.length,
            timestamp: new Date(),
          });
          try {
            results.push(await this.testMcpToolDirect(testId, tool, serverTools, toolTimeout));
          } catch (toolError) {
            results.push({
              toolName: tool.name,
              success: false,
              executionTime: 0,
              error: toolError instanceof Error ? toolError.message : String(toolError),
              mcpCompliant: false,
              timestamp: new Date(),
            });
          }
        }
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`[${testId}] k8s test-pod run failed: ${errMsg}`);
      // If we never got as far as testing tools, surface this as the build
      // error so the result is still a well-formed failure, not a throw. This
      // is by construction a test-INFRASTRUCTURE failure (see
      // McpServerTestResult.infrastructureFailure): the generated code never
      // ran, so nothing here reflects on its quality.
      if (results.length === 0 && !buildError) {
        buildError = errMsg;
        infrastructureFailure = true;
      }
    } finally {
      // Always drop the synthetic handshake entry and tear the sandbox down.
      this.runningProcesses.delete(testId);
      if (handle && config.cleanup !== false) {
        cleanupErrors = await sandbox.destroySandbox(handle);
      } else if (handle) {
        this.logger.warn(
          `[${testId}] cleanup disabled (config.cleanup=false); leaving test sandbox '${handle.name}' in place`,
        );
      }
      this.unregisterProgressCallback(testId);
    }

    const toolsPassedCount = results.filter((r) => r.success).length;
    const overallSuccess =
      buildSuccess &&
      results.length === tools.length &&
      tools.length > 0 &&
      toolsPassedCount === tools.length;

    this.streamProgress(testId, {
      type: 'complete',
      message: `Test completed: ${toolsPassedCount}/${tools.length} tools passed`,
      timestamp: new Date(),
    });

    return {
      containerId: handle?.name || testId,
      imageTag,
      buildSuccess,
      buildError,
      buildDuration,
      toolsFound: tools.length,
      toolsTested: results.length,
      toolsPassedCount,
      results,
      overallSuccess,
      totalDuration: Date.now() - startTime,
      cleanupSuccess: cleanupErrors.length === 0,
      cleanupErrors,
      timestamp: new Date(),
      infrastructureFailure,
    };
  }

  /**
   * Register progress callback for real-time streaming
   */
  registerProgressCallback(testId: string, callback: (update: TestProgressUpdate) => void): void {
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
   * Main test orchestration method. Runs `npm install`, `tsc`, and the
   * generated MCP server itself inside isolated, resource-limited Docker
   * containers (see class doc comment for the full security model).
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

    // --- sandbox backend selection ---------------------------------------
    // A third option in front of the Docker path: run the untrusted server in
    // an isolated Kubernetes test pod. This is for the cluster, where the
    // backend pod has no Docker daemon and must NEVER run generated code in its
    // own process. The Docker path and the fail-closed default below are
    // unchanged; this only ADDS the k8s path, gated on a reachable cluster.
    const sandboxMode = this.resolveSandboxMode();
    if (sandboxMode !== 'docker' && this.k8sSandbox?.isEnabled()) {
      // Docker still wins in 'auto' mode when its daemon is reachable (fast
      // local path); 'k8s' mode forces the cluster path.
      const dockerWins = sandboxMode === 'auto' && (await this.isDockerReachable());
      if (!dockerWins) {
        this.logger.log(
          `[${testId}] Sandbox backend: Kubernetes test pod (MCP_TESTING_SANDBOX=${sandboxMode})`,
        );
        return this.testMcpServerOnK8s(generatedCode, mergedConfig, testId, startTime);
      }
    } else if (sandboxMode === 'k8s') {
      // The operator explicitly asked for the cluster sandbox but none is
      // reachable. Fail closed rather than silently dropping to Docker or the
      // host — the whole point of 'k8s' mode is "only ever a real sandbox".
      throw new Error(this.k8sSandboxUnavailableMessage());
    }

    // Fail fast (and loudly) if Docker isn't available, rather than silently
    // dropping down to unsandboxed host execution of untrusted, LLM-generated
    // code. See ensureDockerAvailable() / MCP_TESTING_ALLOW_UNSANDBOXED.
    await this.ensureDockerAvailable();
    const imageTag = this.dockerAvailable ? this.dockerImage : 'unsandboxed-host-node';

    try {
      this.logger.log(
        `[${testId}] Starting MCP server test (${this.dockerAvailable ? `Docker-sandboxed, image=${this.dockerImage}` : 'UNSANDBOXED host execution'})`,
      );

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
        await this.buildNodeProject(testId, tempDir, mergedConfig);
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
          imageTag,
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

      await this.startMcpServerProcess(testId, tempDir, mergedConfig);
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

      const toolsPassedCount = results.filter((r) => r.success).length;
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
        imageTag,
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
   * Build the Node.js project (npm install + tsc), sandboxed inside Docker
   * containers. Falls back to unsandboxed host execution only when Docker is
   * unavailable AND MCP_TESTING_ALLOW_UNSANDBOXED=true.
   */
  private async buildNodeProject(
    testId: string,
    serverDir: string,
    config: McpTestConfig,
  ): Promise<void> {
    if (!this.dockerAvailable) {
      return this.buildNodeProjectUnsandboxed(serverDir);
    }

    const memoryLimit = config.memoryLimit || this.defaultConfig.memoryLimit!;
    const cpuLimit = config.cpuLimit || this.defaultConfig.cpuLimit!;

    // Step 1: npm install, isolated container with network access (needed to
    // reach the npm registry). `--ignore-scripts` blocks malicious
    // pre/postinstall scripts from LLM-generated package.json, and the
    // container receives NO host environment variables, so there is nothing
    // to exfiltrate even if a script did run.
    this.logger.debug(`[${testId}] Installing dependencies in sandboxed container (${serverDir})`);
    await this.runInDockerContainer({
      testId,
      containerName: `mcp-install-${testId}`,
      stepName: 'npm install',
      timeoutMs: 120000, // 2 minute timeout for npm install
      dockerArgs: [
        '-v',
        `${serverDir}:/work`,
        '-w',
        '/work',
        `--memory=${memoryLimit}`,
        `--cpus=${cpuLimit}`,
        '--pids-limit=256',
        '--network=bridge', // network required to fetch npm packages; no host env is passed regardless
        this.dockerImage,
        'npm',
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
      ],
    });

    // Step 2: compile TypeScript with NO network access at all — dependencies
    // are already on disk from step 1, so tsc needs nothing but the volume.
    this.logger.debug(`[${testId}] Compiling TypeScript in sandboxed container`);
    await this.runInDockerContainer({
      testId,
      containerName: `mcp-build-${testId}`,
      stepName: 'tsc',
      timeoutMs: 60000, // 1 minute timeout for compilation
      dockerArgs: [
        '-v',
        `${serverDir}:/work`,
        '-w',
        '/work',
        `--memory=${memoryLimit}`,
        `--cpus=${cpuLimit}`,
        '--pids-limit=256',
        '--network=none',
        this.dockerImage,
        'npx',
        'tsc',
      ],
    });

    // Verify dist/index.js exists
    const distIndexPath = join(serverDir, 'dist', 'index.js');
    if (!existsSync(distIndexPath)) {
      throw new Error(`Build succeeded but dist/index.js not found at ${distIndexPath}`);
    }

    this.logger.debug(`Build complete, dist/index.js exists`);
  }

  /**
   * Run a single build step (`npm install` / `tsc`) inside a named,
   * `--rm`-flagged Docker container, enforcing a hard timeout that kills the
   * container (not just the local `docker` CLI process — killing the CLI
   * client does NOT reliably stop the container) if it's exceeded.
   *
   * `dockerArgs` should contain everything AFTER `docker run --rm --name
   * <containerName>` (volume mounts, resource limits, image, command).
   */
  private async runInDockerContainer(opts: {
    testId: string;
    containerName: string;
    stepName: string;
    timeoutMs: number;
    dockerArgs: string[];
  }): Promise<void> {
    const { testId, containerName, stepName, timeoutMs, dockerArgs } = opts;
    const args = ['run', '--rm', '--name', containerName, ...dockerArgs];

    this.activeContainerNames.add(containerName);

    try {
      await new Promise<void>((resolve, reject) => {
        let stderr = '';
        let stdout = '';
        let timedOut = false;

        const child = spawn('docker', args, {
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        const timeoutHandle = setTimeout(() => {
          timedOut = true;
          this.logger.warn(
            `[${testId}] ${stepName} exceeded ${timeoutMs}ms, killing container ${containerName}`,
          );
          void this.stopContainer(containerName);
          child.kill('SIGKILL');
        }, timeoutMs);

        child.stdout?.on('data', (data) => {
          stdout += data.toString();
          this.logger.debug(`[${testId}] ${stepName} stdout: ${data.toString().trim()}`);
        });

        child.stderr?.on('data', (data) => {
          stderr += data.toString();
          this.logger.debug(`[${testId}] ${stepName} stderr: ${data.toString().trim()}`);
        });

        child.on('error', (error) => {
          clearTimeout(timeoutHandle);
          reject(new Error(`${stepName} (docker run) failed to start: ${error.message}`));
        });

        child.on('close', (code) => {
          clearTimeout(timeoutHandle);
          if (timedOut) {
            reject(new Error(`${stepName} timed out after ${timeoutMs}ms and was killed`));
          } else if (code === 0) {
            resolve();
          } else {
            reject(new Error(`${stepName} failed with code ${code}: ${stderr || stdout}`));
          }
        });
      });
    } finally {
      this.activeContainerNames.delete(containerName);
    }
  }

  /**
   * UNSANDBOXED fallback for `npm install` + `tsc`, only reachable when
   * Docker is unavailable and MCP_TESTING_ALLOW_UNSANDBOXED=true. Runs
   * LLM-generated build steps directly on the host with the full host
   * environment (see ensureDockerAvailable for the warning that is logged
   * once per test run before this path is ever taken).
   */
  private async buildNodeProjectUnsandboxed(serverDir: string): Promise<void> {
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
   * Start the MCP server for testing, sandboxed inside a Docker container
   * (`docker run -i`) so that the child process's stdin/stdout are the
   * container's stdio.
   *
   * Transport-dependent behavior (see `McpTestConfig.transport`):
   *  - 'stdio': the container's stdin/stdout ARE the JSON-RPC channel (as
   *    before) — the rest of this service's handshake/testing logic
   *    (sendMcpMessageDirect, waitForServerReady, etc.) treats it exactly
   *    like the previous in-process child.
   *  - 'http' (default): the container is started with
   *    `-e MCP_TRANSPORT=http -e PORT=3000` and a DYNAMIC published port
   *    (`-p 0:3000`, host port chosen by the Docker daemon), which is read
   *    back via `docker port <container> 3000` right after the container
   *    starts. This service then speaks MCP Streamable HTTP to
   *    `http://127.0.0.1:<hostPort>` via `McpHttpTransportClient`.
   *
   * NOTE: the HTTP branch of this Docker path is UNVERIFIED in this change —
   * there is no Docker daemon available in the environment this was written
   * in, so it could only be reviewed carefully, not exercised. The
   * unsandboxed HTTP path below (`startMcpServerProcessUnsandboxed`) IS
   * verified end-to-end.
   */
  private async startMcpServerProcess(
    testId: string,
    serverDir: string,
    config: McpTestConfig,
  ): Promise<any> {
    if (!this.dockerAvailable) {
      return this.startMcpServerProcessUnsandboxed(testId, serverDir, config);
    }

    const transport: McpTransportMode = config.transport || DEFAULT_MCP_TRANSPORT;
    const memoryLimit = config.memoryLimit || this.defaultConfig.memoryLimit!;
    const cpuLimit = config.cpuLimit || this.defaultConfig.cpuLimit!;
    const networkMode = config.networkMode || this.defaultConfig.networkMode!;
    const containerName = `mcp-run-${testId}`;

    const args = [
      'run',
      '--rm',
      '-i',
      '--name',
      containerName,
      '-v',
      `${serverDir}:/app:ro`,
      '--tmpfs',
      '/tmp',
      '-w',
      '/app',
      `--memory=${memoryLimit}`,
      `--cpus=${cpuLimit}`,
      '--pids-limit=256',
      `--network=${networkMode}`,
      '--read-only',
      '-e',
      'NODE_ENV=test',
    ];

    if (transport === 'http') {
      // Publish container port 3000 to a Docker-daemon-assigned ephemeral
      // host port (`0:3000`). We read the assigned host port back below via
      // `docker port`, once the container is running.
      args.push('-p', '0:3000', '-e', 'MCP_TRANSPORT=http', '-e', 'PORT=3000');
    }

    args.push(this.dockerImage, 'node', 'dist/index.js');

    this.logger.debug(`[${testId}] Starting sandboxed MCP server: docker ${args.join(' ')}`);
    this.activeContainerNames.add(containerName);

    const serverProcess = spawn('docker', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Store reference for later communication
    this.runningProcesses.set(testId, {
      process: serverProcess,
      serverDir,
      containerName,
      transport,
      pendingResponses: new Map<
        string | number,
        { resolve: (response: McpResponse) => void; reject: (error: Error) => void }
      >(),
      buffer: '',
      stderrBuffer: '', // Capture stderr for debugging
      ready: false, // Track readiness state
    });

    // Set up stdout handler to parse JSON-RPC responses (stdio transport
    // only — in http mode nothing on stdout carries JSON-RPC, so this is a
    // harmless no-op there).
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
          this.logger.debug(
            `[${testId}] MCP response: ${JSON.stringify(response).substring(0, 200)}`,
          );

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
      const processInfo = this.runningProcesses.get(testId);
      if (processInfo) {
        processInfo.stderrBuffer += data.toString();
      }
      this.logger.debug(`[${testId}] MCP server stderr: ${data.toString().trim()}`);
    });

    serverProcess.on('error', (error) => {
      this.logger.error(`[${testId}] MCP server process error: ${error.message}`);
    });

    serverProcess.on('close', (code) => {
      this.logger.log(`[${testId}] MCP server process exited with code ${code}`);
      this.activeContainerNames.delete(containerName);
      this.runningProcesses.delete(testId);
    });

    if (transport === 'http') {
      // UNVERIFIED (no local Docker daemon to test against): read back the
      // host port the daemon assigned to container port 3000. `docker port`
      // can race the container's own startup very slightly, so retry briefly.
      const hostPort = await this.resolveDockerHostPort(testId, containerName, 3000, 5000);
      const processInfo = this.runningProcesses.get(testId);
      if (processInfo) {
        processInfo.httpClient = new McpHttpTransportClient(`http://127.0.0.1:${hostPort}`);
        processInfo.port = hostPort;
      }
    }

    // Wait for server to be ready to accept messages
    await this.waitForServerReady(testId, 10000); // 10 second max wait

    return serverProcess;
  }

  /**
   * Read back the host port Docker assigned for a dynamically-published
   * container port (`-p 0:<containerPort>`), via `docker port <name>
   * <containerPort>`. Output looks like `0.0.0.0:54321` (and/or a second
   * `[::]:54321` line for IPv6) — the last colon-separated segment is the
   * port. UNVERIFIED: written carefully against documented `docker port`
   * output but never run against a real Docker daemon.
   */
  private async resolveDockerHostPort(
    testId: string,
    containerName: string,
    containerPort: number,
    maxWaitMs: number,
  ): Promise<number> {
    const startTime = Date.now();
    let lastError: unknown;

    while (Date.now() - startTime < maxWaitMs) {
      try {
        const { stdout } = await execAsync(`docker port ${containerName} ${containerPort}`, {
          timeout: 3000,
        });
        const firstLine = stdout.trim().split('\n')[0]?.trim();
        const portStr = firstLine?.split(':').pop();
        const port = portStr ? Number(portStr) : NaN;
        if (Number.isInteger(port) && port > 0) {
          this.logger.debug(
            `[${testId}] Resolved Docker host port ${port} for container ${containerName}:${containerPort}`,
          );
          return port;
        }
        lastError = new Error(`Could not parse port from "docker port" output: "${stdout}"`);
      } catch (error) {
        lastError = error;
      }
      await this.delay(150);
    }

    throw new Error(
      `Failed to resolve published host port for ${containerName}:${containerPort} within ${maxWaitMs}ms: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  }

  /**
   * UNSANDBOXED fallback for starting the MCP server, only reachable when
   * Docker is unavailable and MCP_TESTING_ALLOW_UNSANDBOXED=true.
   *
   * VERIFIED for the 'http' transport: an ephemeral free port is allocated
   * on the host, and the server is spawned with `MCP_TRANSPORT=http` and
   * `PORT=<that port>`. This is the same env-var contract dual-transport
   * generated servers implement (see class doc comment).
   */
  private async startMcpServerProcessUnsandboxed(
    testId: string,
    serverDir: string,
    config?: McpTestConfig,
  ): Promise<any> {
    const distIndexPath = join(serverDir, 'dist', 'index.js');
    const transport: McpTransportMode = config?.transport || DEFAULT_MCP_TRANSPORT;

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: 'test',
    };

    let port: number | undefined;
    if (transport === 'http') {
      port = await allocateFreePort();
      env.MCP_TRANSPORT = 'http';
      env.PORT = String(port);
    }

    const serverProcess = spawn('node', [distIndexPath], {
      cwd: serverDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    // Store reference for later communication
    this.runningProcesses.set(testId, {
      process: serverProcess,
      serverDir,
      transport,
      port,
      httpClient:
        transport === 'http' ? new McpHttpTransportClient(`http://127.0.0.1:${port}`) : undefined,
      pendingResponses: new Map<
        string | number,
        { resolve: (response: McpResponse) => void; reject: (error: Error) => void }
      >(),
      buffer: '',
      stderrBuffer: '', // Capture stderr for debugging
      ready: false, // Track readiness state
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
          this.logger.debug(
            `[${testId}] MCP response: ${JSON.stringify(response).substring(0, 200)}`,
          );

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
      const processInfo = this.runningProcesses.get(testId);
      if (processInfo) {
        processInfo.stderrBuffer += data.toString();
      }
      this.logger.debug(`[${testId}] MCP server stderr: ${data.toString().trim()}`);
    });

    serverProcess.on('error', (error) => {
      this.logger.error(`[${testId}] MCP server process error: ${error.message}`);
    });

    serverProcess.on('close', (code) => {
      this.logger.log(`[${testId}] MCP server process exited with code ${code}`);
      this.runningProcesses.delete(testId);
    });

    // Wait for server to be ready to accept messages
    await this.waitForServerReady(testId, 10000); // 10 second max wait

    return serverProcess;
  }

  /**
   * Wait for MCP server to be ready to accept messages
   * Uses exponential backoff trying to initialize the server
   */
  private async waitForServerReady(testId: string, maxWaitMs: number): Promise<void> {
    const processInfo = this.runningProcesses.get(testId);
    if (!processInfo) {
      throw new Error('MCP server process not found');
    }

    const startTime = Date.now();
    let attempt = 0;
    const baseDelayMs = 200;
    const maxDelayMs = 2000;

    while (Date.now() - startTime < maxWaitMs) {
      attempt++;

      // Check if process exited
      if (processInfo.process.exitCode !== null) {
        const stderr = processInfo.stderrBuffer || 'No stderr output';
        throw new Error(
          `MCP server exited with code ${processInfo.process.exitCode}. Stderr: ${stderr}`,
        );
      }

      if (processInfo.transport === 'http') {
        // HTTP transport: poll GET /health instead of checking stdin.
        const healthy = await processInfo.httpClient.isHealthy();
        if (!healthy) {
          await this.delay(100);
          continue;
        }
      } else if (!processInfo.process.stdin?.writable) {
        // stdio transport: stdin must be writable before we can even attempt
        // an initialize call.
        await this.delay(100);
        continue;
      }

      // Try initialize
      try {
        const initResult = await this.sendInitializeMessage(testId, 3000);
        if (initResult.success) {
          this.logger.log(
            `[${testId}] MCP server ready after ${attempt} attempts (${Date.now() - startTime}ms)`,
          );
          processInfo.ready = true;
          return;
        }
      } catch (error) {
        this.logger.debug(
          `[${testId}] Initialize attempt ${attempt} failed: ${(error as Error).message}`,
        );
      }

      // Exponential backoff
      const delayMs = Math.min(baseDelayMs * Math.pow(1.5, attempt - 1), maxDelayMs);
      await this.delay(delayMs);
    }

    const stderr = processInfo.stderrBuffer || 'No stderr output';
    throw new Error(
      `MCP server failed to become ready within ${maxWaitMs}ms. Stderr: ${stderr.substring(0, 500)}`,
    );
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Send initialize message and wait for response
   * Used for readiness checking with retry logic
   */
  private async sendInitializeMessage(
    testId: string,
    timeout: number,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const initMessage: McpMessage = {
        jsonrpc: '2.0',
        id: `init-${Date.now()}`,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: {
            name: 'mcp-testing-service',
            version: '1.0.0',
          },
        },
      };

      const response = await this.sendMcpMessageDirect(testId, initMessage, timeout / 1000);

      if (response.error) {
        return { success: false, error: response.error.message };
      }

      // Send initialized notification
      await this.sendInitializedNotification(testId);

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Send the `notifications/initialized` fire-and-forget notification over
   * whichever transport this test/validation is using.
   */
  private async sendInitializedNotification(testId: string): Promise<void> {
    const processInfo = this.runningProcesses.get(testId);
    if (!processInfo) return;

    if (processInfo.transport === 'http') {
      await processInfo.httpClient.notify('notifications/initialized');
      return;
    }

    const notificationMessage = {
      jsonrpc: '2.0' as const,
      method: 'notifications/initialized',
    };
    processInfo.process.stdin.write(JSON.stringify(notificationMessage) + '\n');
  }

  /**
   * Stop the MCP server process. When sandboxed, the process being tracked
   * is the local `docker run -i` CLI client — killing that client process
   * does NOT reliably stop the container it's attached to (verified: the
   * container can keep running after the client is killed), so the container
   * is explicitly stopped/killed by name. `--rm` guarantees it's removed
   * immediately afterward, leaving no orphans.
   */
  private async stopMcpServerProcess(testId: string): Promise<void> {
    const processInfo = this.runningProcesses.get(testId);
    if (!processInfo) return;

    const containerName: string | undefined = processInfo.containerName;

    try {
      if (containerName) {
        await this.stopContainer(containerName);
      } else {
        processInfo.process.kill('SIGTERM');
      }

      // Wait for the local client/process to close, then force kill it too.
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          try {
            processInfo.process.kill('SIGKILL');
          } catch {
            // Process may already be gone.
          }
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

    if (containerName) {
      this.activeContainerNames.delete(containerName);
    }
    this.runningProcesses.delete(testId);
  }

  /**
   * Authoritatively stop (and, thanks to `--rm`, remove) a Docker container
   * by name. Tries a graceful `docker stop` first, falls back to `docker
   * kill`. Both are best-effort/idempotent — if the container is already
   * gone, the errors are swallowed.
   */
  private async stopContainer(containerName: string): Promise<void> {
    try {
      await execAsync(`docker stop -t 3 ${containerName}`, { timeout: 8000 });
      return;
    } catch {
      // Fall through to a hard kill below.
    }

    try {
      await execAsync(`docker kill ${containerName}`, { timeout: 5000 });
    } catch {
      // Container was likely already stopped/removed (e.g. exited on its own) — fine.
    }
  }

  /**
   * Send a JSON-RPC message to the MCP server and wait for response.
   * `timeout` is in SECONDS (matches all existing callers).
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

    if (processInfo.transport === 'http') {
      return processInfo.httpClient.send(message, timeout * 1000);
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
    const processInfo = this.runningProcesses.get(testId);

    // If already initialized during readiness check, return success
    if (processInfo?.ready) {
      this.logger.debug(`[${testId}] Server already initialized during startup`);
      return { success: true };
    }

    // Fallback to original logic if not already initialized
    try {
      const initMessage: McpMessage = {
        jsonrpc: '2.0',
        id: `init-${Date.now()}`,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
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
      await this.sendInitializedNotification(testId);

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
      // Add diagnostic when serverTools is empty
      if (serverTools.length === 0) {
        const processInfo = this.runningProcesses.get(testId);
        const stderr = processInfo?.stderrBuffer || 'No stderr captured';
        return {
          toolName: tool.name,
          success: false,
          executionTime: Date.now() - startTime,
          error: `Server returned 0 tools. Server may have failed to start properly. Stderr: ${stderr.substring(0, 200)}`,
          mcpCompliant: false,
          timestamp: new Date(),
        };
      }

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
    const tempDir = join(
      this.tempBaseDir,
      `server-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    );

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
