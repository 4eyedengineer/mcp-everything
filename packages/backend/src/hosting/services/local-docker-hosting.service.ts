import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChildProcessWithoutNullStreams, execFile, spawn } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Result of the MCP handshake (initialize + notifications/initialized +
 * tools/list) performed right after starting a container. This is the real
 * verification step that a "docker-run" hosting deploy is actually a working
 * MCP server, rather than just "the docker build/run commands exited 0".
 *
 * Generated servers are dual-transport (`MCP_TRANSPORT=stdio|http`, stdio
 * being the default), so which transport was actually exercised is recorded
 * on the result rather than assumed - `transport` reflects reality, not a
 * hardcoded label.
 */
export interface McpHandshakeResult {
  success: boolean;
  transport?: 'stdio' | 'http';
  protocolVersion?: string;
  serverInfo?: { name?: string; version?: string };
  tools?: Array<{ name: string; description?: string }>;
  error?: string;
}

interface TrackedContainer {
  containerName: string;
  image: string;
  process: ChildProcessWithoutNullStreams;
  buffer: string;
  stderrBuffer: string;
  pendingResponses: Map<
    string | number,
    { resolve: (response: any) => void; reject: (error: Error) => void }
  >;
  exited: boolean;
  exitCode: number | null;
}

/**
 * Runs generated MCP servers as real local Docker containers instead of
 * pushing to a registry and committing K8s manifests for ArgoCD to pick up.
 *
 * This exists because of the environment this was first exercised in
 * (WSL2 distro with no docker CLI on PATH, no image registry, no Kubernetes
 * cluster - see DEPLOYMENT.md "local hosting on WSL2") but it is a generally
 * useful "HOSTING_MODE=docker-run" path for anyone who wants to smoke-test
 * the Host on Cloud flow without a cluster: it builds the image, runs it,
 * and proves the container is a real, responding MCP server by performing
 * the initialize/tools-list handshake against it.
 *
 * Generated servers are now dual-transport (`MCP_TRANSPORT=stdio` (default)
 * or `http`, selected at container start via env vars) - HTTP mode listens
 * on `PORT` (default 3000), speaks MCP Streamable HTTP at `POST /mcp`, and
 * exposes `GET /health`. This service picks its verification strategy based
 * on the `MCP_TRANSPORT` entry in the `envVars` passed to `startAndVerify`:
 *   - stdio (default, or when `MCP_TRANSPORT` is absent/not "http"): no port
 *     is published; the handshake is a raw JSON-RPC conversation over the
 *     container's stdin/stdout, exactly as before.
 *   - http: the container's HTTP port is published to a deterministic local
 *     host port (see `httpHostPortFor`), `GET /health` is polled until it
 *     returns 200, and the handshake is a real Streamable HTTP conversation
 *     (POST /mcp, `Mcp-Session-Id` tracked across requests, SSE-framed
 *     responses parsed) - see `performHttpHandshake`.
 *
 * Containers are started in the foreground (`docker run -i --rm`, no `-d`)
 * and tracked by the ChildProcess handle exactly like
 * McpTestingService.runningProcesses - this is a deliberate, honest
 * limitation: a container's lifetime is tied to this backend process, so a
 * backend restart loses track of (and orphans) any running local-docker
 * hosted servers. A real Kubernetes Deployment would survive that via the
 * kubelet/ReplicaSet; reproducing that here would mean reimplementing a
 * container supervisor, which is exactly the boundary where real cluster
 * infra is required (see DEPLOYMENT.md).
 */
@Injectable()
export class LocalDockerHostingService implements OnModuleDestroy {
  private readonly logger = new Logger(LocalDockerHostingService.name);
  private readonly dockerBin: string;
  private readonly defaultHandshakeTimeoutMs: number;
  private readonly containers = new Map<string, TrackedContainer>();

  constructor(private readonly configService: ConfigService) {
    this.dockerBin = this.configService.get<string>('DOCKER_BIN', 'docker');
    this.defaultHandshakeTimeoutMs = Number(
      this.configService.get<string>('MCP_HANDSHAKE_TIMEOUT_MS', '15000'),
    );
  }

  async onModuleDestroy(): Promise<void> {
    const serverIds = Array.from(this.containers.keys());
    if (serverIds.length === 0) return;
    this.logger.warn(
      `Shutting down with ${serverIds.length} local-docker hosted container(s) still tracked; stopping: ${serverIds.join(', ')}`,
    );
    await Promise.all(serverIds.map((id) => this.stopContainer(id)));
  }

  /** Deterministic, docker-safe container name for a hosted server. */
  containerNameFor(serverId: string): string {
    return `mcp-hosted-${serverId}`;
  }

  /**
   * Deterministic local host port for an HTTP-transport docker-run hosted
   * server, derived from its `serverId`.
   *
   * This is deliberately a pure hash rather than `docker run -P` +
   * `docker port` inspection: `hosting.service.ts` needs to compute the
   * final `http://localhost:<port>` `endpointUrl` for a `HostedServer` row
   * up front, before the container has actually started, and it can do that
   * safely only if calling this function with the same `serverId` always
   * yields the same port. Range 20000-29999 is chosen to stay clear of both
   * common well-known ports and this backend's own default port range.
   *
   * Honesty boundary: this is a single-host, best-effort dev/demo hosting
   * mode, not a real scheduler - two concurrently-hosted `serverId`s can, in
   * principle, hash to the same port. `docker run -p` would then fail to
   * bind and the deployment surfaces as `failed`, which is an acceptable
   * outcome for this mode (see the class doc comment above).
   */
  httpHostPortFor(serverId: string): number {
    const base = 20000;
    const range = 10000;
    let hash = 0;
    for (let i = 0; i < serverId.length; i++) {
      hash = (hash * 31 + serverId.charCodeAt(i)) >>> 0;
    }
    return base + (hash % range);
  }

  /**
   * Build the generated server's Dockerfile into a local image tag. No push:
   * `docker-run` mode never touches a registry.
   */
  async buildImage(serverDir: string, serverId: string, tag = 'latest'): Promise<string> {
    const imageName = `mcp-local/${serverId}:${tag}`;
    this.logger.log(`Building local image ${imageName} from ${serverDir}`);
    try {
      await execFileAsync(this.dockerBin, ['build', '-t', imageName, serverDir], {
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Docker build failed: ${message}`);
    }
    return imageName;
  }

  /**
   * Start the image as a container and immediately verify it's a working
   * MCP server via initialize + tools/list. Throws if the container fails to
   * start or fails the handshake (callers should treat that as a failed
   * deployment, not a "running" one - never mark a server 'running' without
   * this succeeding).
   *
   * Transport is selected by the caller via `envVars.MCP_TRANSPORT`, mirroring
   * exactly how the generated server itself decides at boot: "http"
   * (case-insensitive) verifies over Streamable HTTP with a published port;
   * anything else (absent, "stdio", or unrecognized) verifies over the raw
   * stdio JSON-RPC handshake with no port published, as before.
   */
  async startAndVerify(
    serverId: string,
    imageName: string,
    envVars: Record<string, string> = {},
    handshakeTimeoutMs: number = this.defaultHandshakeTimeoutMs,
  ): Promise<{ containerName: string; handshake: McpHandshakeResult }> {
    // Clean up any stale tracked container under this serverId first.
    if (this.containers.has(serverId)) {
      await this.stopContainer(serverId);
    }

    const transport: 'stdio' | 'http' =
      (envVars.MCP_TRANSPORT ?? 'stdio').toLowerCase() === 'http' ? 'http' : 'stdio';

    const containerName = this.containerNameFor(serverId);
    const envFlags = Object.entries(envVars).flatMap(([key, value]) => ['-e', `${key}=${value}`]);

    let hostPort: number | undefined;
    let containerPort: number | undefined;
    const portFlags: string[] = [];
    if (transport === 'http') {
      containerPort = Number(envVars.PORT) || 3000;
      hostPort = this.httpHostPortFor(serverId);
      portFlags.push('-p', `${hostPort}:${containerPort}`);
    }

    const args = ['run', '--rm', '-i', '--name', containerName, ...portFlags, ...envFlags, imageName];

    this.logger.log(`Starting local container (${transport} transport): ${this.dockerBin} ${args.join(' ')}`);

    const child = spawn(this.dockerBin, args, { stdio: ['pipe', 'pipe', 'pipe'] });

    const tracked: TrackedContainer = {
      containerName,
      image: imageName,
      process: child,
      buffer: '',
      stderrBuffer: '',
      pendingResponses: new Map(),
      exited: false,
      exitCode: null,
    };
    this.containers.set(serverId, tracked);

    child.stdout.on('data', (data: Buffer) => {
      tracked.buffer += data.toString();
      const lines = tracked.buffer.split('\n');
      tracked.buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          const pending = tracked.pendingResponses.get(message.id);
          if (pending) {
            pending.resolve(message);
            tracked.pendingResponses.delete(message.id);
          }
        } catch {
          this.logger.debug(`[${containerName}] non-JSON stdout: ${line}`);
        }
      }
    });

    child.stderr.on('data', (data: Buffer) => {
      tracked.stderrBuffer += data.toString();
      this.logger.debug(`[${containerName}] stderr: ${data.toString().trim()}`);
    });

    child.on('exit', (code) => {
      tracked.exited = true;
      tracked.exitCode = code;
      this.logger.log(`[${containerName}] container process exited with code ${code}`);
    });

    let handshake: McpHandshakeResult;
    try {
      handshake =
        transport === 'http'
          ? await this.performHttpHandshake(tracked, hostPort!, handshakeTimeoutMs)
          : await this.performHandshake(tracked, handshakeTimeoutMs);
    } catch (error) {
      handshake = {
        success: false,
        transport,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    if (!handshake.success) {
      // Don't leave a half-verified container tracked as "hosted".
      await this.stopContainer(serverId);
      throw new Error(handshake.error || 'MCP handshake failed for unknown reason');
    }

    return { containerName, handshake };
  }

  private sendMessage(tracked: TrackedContainer, message: Record<string, unknown>): void {
    tracked.process.stdin.write(JSON.stringify(message) + '\n');
  }

  private async sendRequest(
    tracked: TrackedContainer,
    method: string,
    params: Record<string, unknown> | undefined,
    timeoutMs: number,
  ): Promise<any> {
    const id = `${method}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const responsePromise = new Promise<any>((resolve, reject) => {
      tracked.pendingResponses.set(id, { resolve, reject });
    });

    this.sendMessage(tracked, { jsonrpc: '2.0', id, method, params });

    let timeoutHandle: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        tracked.pendingResponses.delete(id);
        reject(new Error(`Timed out waiting for response to '${method}' after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    try {
      return await Promise.race([responsePromise, timeout]);
    } finally {
      // Whichever side of the race wins, the other must not keep a timer
      // alive (leaks a handle and, in tests, keeps the process from exiting).
      clearTimeout(timeoutHandle!);
    }
  }

  /**
   * Perform the standard MCP client handshake: initialize, then the
   * notifications/initialized notification, then tools/list - proving the
   * container is a real, spec-compliant MCP server and returning its
   * advertised tool set for comparison against what generation produced.
   */
  private async performHandshake(
    tracked: TrackedContainer,
    timeoutMs: number,
  ): Promise<McpHandshakeResult> {
    const deadline = Date.now() + timeoutMs;

    // Wait for the process to either exit early (fatal startup error) or
    // become writable.
    while (!tracked.process.stdin.writable && Date.now() < deadline) {
      if (tracked.exited) {
        return {
          success: false,
          transport: 'stdio',
          error: `Container exited before it could be initialized (code ${tracked.exitCode}). Stderr: ${tracked.stderrBuffer.slice(0, 1000) || 'none'}`,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    try {
      const initResponse = await this.sendRequest(
        tracked,
        'initialize',
        {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'mcp-everything-hosting', version: '1.0.0' },
        },
        Math.max(1000, deadline - Date.now()),
      );

      if (initResponse.error) {
        return {
          success: false,
          transport: 'stdio',
          error: `initialize error: ${initResponse.error.message}`,
        };
      }

      this.sendMessage(tracked, { jsonrpc: '2.0', method: 'notifications/initialized' });

      const toolsResponse = await this.sendRequest(
        tracked,
        'tools/list',
        undefined,
        Math.max(1000, deadline - Date.now()),
      );

      if (toolsResponse.error) {
        return {
          success: false,
          transport: 'stdio',
          error: `tools/list error: ${toolsResponse.error.message}`,
        };
      }

      return {
        success: true,
        transport: 'stdio',
        protocolVersion: initResponse.result?.protocolVersion,
        serverInfo: initResponse.result?.serverInfo,
        tools: (toolsResponse.result?.tools || []).map((t: any) => ({
          name: t.name,
          description: t.description,
        })),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        transport: 'stdio',
        error: `${message}${tracked.stderrBuffer ? ` | stderr: ${tracked.stderrBuffer.slice(0, 500)}` : ''}`,
      };
    }
  }

  /**
   * Poll `GET /health` on the published host port until it returns 200 (or
   * the container exits, or the deadline passes). Mirrors the same
   * "wait for the process to become ready" role the stdio path's
   * stdin-writable wait plays above, just over HTTP instead.
   */
  private async waitForHealthy(
    tracked: TrackedContainer,
    hostPort: number,
    deadline: number,
  ): Promise<void> {
    while (Date.now() < deadline) {
      if (tracked.exited) {
        throw new Error(
          `Container exited before it became healthy (code ${tracked.exitCode}). Stderr: ${tracked.stderrBuffer.slice(0, 1000) || 'none'}`,
        );
      }
      try {
        const res = await fetch(`http://localhost:${hostPort}/health`, {
          signal: AbortSignal.timeout(1000),
        });
        if (res.ok) return;
      } catch {
        // Not up yet (connection refused / timed out) - keep polling.
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error(`Timed out waiting for GET /health to return 200 on http://localhost:${hostPort}`);
  }

  /**
   * Parse a Streamable HTTP response body into its constituent JSON-RPC
   * messages. Responses come back SSE-framed (`event: message\ndata:
   * {...}\n\n`), not as a bare JSON body - confirmed empirically against the
   * SDK's `StreamableHTTPServerTransport`, which always uses the
   * `text/event-stream` framing for POST responses regardless of whether
   * there's one message or many. Falls back to parsing the raw body as JSON
   * in case a future/alternate implementation ever replies with a plain
   * `application/json` body instead.
   */
  private parseSseMessages(body: string): any[] {
    const messages: any[] = [];
    for (const rawEvent of body.split('\n\n')) {
      const dataLines = rawEvent
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trimStart());
      if (dataLines.length === 0) continue;
      try {
        messages.push(JSON.parse(dataLines.join('\n')));
      } catch {
        // Not a JSON-RPC frame (e.g. a keep-alive comment) - skip it.
      }
    }
    if (messages.length === 0 && body.trim().length > 0) {
      try {
        messages.push(JSON.parse(body));
      } catch {
        // Genuinely unparseable - caller treats "no messages" as a failure.
      }
    }
    return messages;
  }

  /**
   * POST a single JSON-RPC message to the Streamable HTTP `/mcp` endpoint.
   *
   * Two details here are load-bearing and were confirmed empirically against
   * the reference dual-transport server, not assumed from the spec text
   * alone:
   *   - `Accept: application/json, text/event-stream` is required on every
   *     request; omitting the `text/event-stream` half of that header gets a
   *     406 from the SDK's transport.
   *   - The server issues a session id via the `Mcp-Session-Id` response
   *     header on `initialize`; every subsequent request (including the
   *     `notifications/initialized` notification) must echo it back via the
   *     same request header, or the server rejects it as a "no valid session
   *     ID" 400.
   */
  private async postMcpMessage(
    hostPort: number,
    message: Record<string, unknown>,
    sessionId: string | undefined,
    timeoutMs: number,
  ): Promise<{ status: number; sessionId?: string; messages: any[] }> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (sessionId) {
      headers['Mcp-Session-Id'] = sessionId;
    }

    const res = await fetch(`http://localhost:${hostPort}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(Math.max(1000, timeoutMs)),
    });

    const text = await res.text();
    return {
      status: res.status,
      sessionId: res.headers.get('mcp-session-id') ?? undefined,
      messages: this.parseSseMessages(text),
    };
  }

  /**
   * Perform the MCP handshake (initialize + notifications/initialized +
   * tools/list) over Streamable HTTP against a container's published port,
   * once `GET /health` reports ready. Same purpose as `performHandshake`
   * above, just over HTTP instead of stdio.
   */
  private async performHttpHandshake(
    tracked: TrackedContainer,
    hostPort: number,
    timeoutMs: number,
  ): Promise<McpHandshakeResult> {
    const deadline = Date.now() + timeoutMs;

    try {
      await this.waitForHealthy(tracked, hostPort, deadline);

      const initRes = await this.postMcpMessage(
        hostPort,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'mcp-everything-hosting', version: '1.0.0' },
          },
        },
        undefined,
        Math.max(1000, deadline - Date.now()),
      );

      const sessionId = initRes.sessionId;
      if (!sessionId) {
        return {
          success: false,
          transport: 'http',
          error: `initialize did not return an Mcp-Session-Id header (HTTP ${initRes.status})`,
        };
      }

      const initMessage = initRes.messages.find((m) => m.id === 1) ?? initRes.messages[0];
      if (!initMessage) {
        return {
          success: false,
          transport: 'http',
          error: `initialize returned no parseable JSON-RPC message (HTTP ${initRes.status})`,
        };
      }
      if (initMessage.error) {
        return { success: false, transport: 'http', error: `initialize error: ${initMessage.error.message}` };
      }

      // Notification - no id, no meaningful response body expected.
      await this.postMcpMessage(
        hostPort,
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        sessionId,
        Math.max(1000, deadline - Date.now()),
      );

      const toolsRes = await this.postMcpMessage(
        hostPort,
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
        sessionId,
        Math.max(1000, deadline - Date.now()),
      );

      const toolsMessage = toolsRes.messages.find((m) => m.id === 2) ?? toolsRes.messages[0];
      if (!toolsMessage) {
        return {
          success: false,
          transport: 'http',
          error: `tools/list returned no parseable JSON-RPC message (HTTP ${toolsRes.status})`,
        };
      }
      if (toolsMessage.error) {
        return { success: false, transport: 'http', error: `tools/list error: ${toolsMessage.error.message}` };
      }

      return {
        success: true,
        transport: 'http',
        protocolVersion: initMessage.result?.protocolVersion,
        serverInfo: initMessage.result?.serverInfo,
        tools: (toolsMessage.result?.tools || []).map((t: any) => ({
          name: t.name,
          description: t.description,
        })),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        transport: 'http',
        error: `${message}${tracked.stderrBuffer ? ` | stderr: ${tracked.stderrBuffer.slice(0, 500)}` : ''}`,
      };
    }
  }

  /**
   * Call a single tool on an already-running, already-verified container.
   * Used for deeper verification beyond tools/list (optional, best-effort).
   */
  async callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs = 15000,
  ): Promise<any> {
    const tracked = this.containers.get(serverId);
    if (!tracked) {
      throw new Error(`No tracked local-docker container for server ${serverId}`);
    }
    return this.sendRequest(tracked, 'tools/call', { name: toolName, arguments: args }, timeoutMs);
  }

  /** True if we believe (in-memory) the container is still alive. */
  isTracked(serverId: string): boolean {
    const tracked = this.containers.get(serverId);
    return !!tracked && !tracked.exited;
  }

  /**
   * Ground-truth check against the Docker daemon itself (not just our
   * in-memory bookkeeping) - `docker ps` is the actual source of truth for
   * whether the container is running.
   */
  async isRunningInDocker(serverId: string): Promise<boolean> {
    const containerName = this.containerNameFor(serverId);
    try {
      const { stdout } = await execFileAsync(this.dockerBin, [
        'ps',
        '--filter',
        `name=^${containerName}$`,
        '--format',
        '{{.Names}}',
      ]);
      return stdout.trim() === containerName;
    } catch {
      return false;
    }
  }

  /**
   * Real container logs via `docker logs` - this works regardless of the
   * fact that the container was started in the foreground (`-i`, no `-d`):
   * Docker's log driver captures stdout/stderr independently of whether a
   * client is attached.
   */
  async getLogs(serverId: string, lines = 100): Promise<string[]> {
    const containerName = this.containerNameFor(serverId);
    try {
      const { stdout, stderr } = await execFileAsync(this.dockerBin, [
        'logs',
        '--tail',
        String(lines),
        containerName,
      ]);
      const combined = `${stdout}${stderr}`;
      return combined.split('\n').filter((line) => line.length > 0);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to fetch logs for ${containerName}: ${message}`);
    }
  }

  /**
   * Stop (and, since containers are started with --rm, thereby remove) a
   * hosted container. Ends stdin first (graceful EOF, same shutdown signal a
   * real MCP client disconnecting would send), then falls back to
   * `docker stop`/`docker kill` by name in case the CLI client process
   * itself is wedged.
   */
  async stopContainer(serverId: string): Promise<void> {
    const tracked = this.containers.get(serverId);
    const containerName = tracked?.containerName ?? this.containerNameFor(serverId);

    if (tracked && !tracked.exited) {
      try {
        tracked.process.stdin.end();
      } catch {
        // ignore - process may already be gone
      }
    }

    // Belt-and-suspenders: explicitly stop the container by name too, since
    // killing/ending stdin on the local CLI client does not always promptly
    // stop the container itself.
    try {
      await execFileAsync(this.dockerBin, ['stop', '--time', '5', containerName]);
    } catch {
      // Container may have already exited (--rm removes it automatically),
      // or never fully started - not an error worth surfacing.
    }

    this.containers.delete(serverId);
  }
}
