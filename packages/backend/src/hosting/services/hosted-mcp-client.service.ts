import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { HostedServer } from '../../database/entities/hosted-server.entity';
import { McpUpstreamResolver } from './mcp-upstream-resolver.service';

/**
 * A tool as advertised by a running hosted server's `tools/list`.
 *
 * Deliberately NOT `HostedServer.tools` (the jsonb snapshot taken at deploy
 * time): that column records what the server said once, at handshake, and goes
 * stale the moment the server is redeployed from changed source. Anything that
 * is about to *call* a tool needs the live answer.
 */
export interface HostedToolDescriptor {
  name: string;
  description?: string;
  /** JSON Schema object exactly as returned by `tools/list`. */
  inputSchema: Record<string, unknown>;
}

/** Identity this backend presents to hosted servers during `initialize`. */
const CLIENT_INFO = { name: 'mcp-everything-aggregator', version: '1.0.0' } as const;

const DEFAULT_IDLE_MS = 10 * 60 * 1000;
const DEFAULT_LIST_TIMEOUT_MS = 10_000;
const DEFAULT_CALL_TIMEOUT_MS = 30_000;

/**
 * Upper bound on the best-effort `DELETE /mcp` sent when a session is torn
 * down. Bounded because teardown happens on shutdown and on idle timers, where
 * a hung socket to a pod that is already going away must never be able to hold
 * the process (or a Jest worker) open.
 */
const TERMINATE_GRACE_MS = 2_000;

interface Session {
  client: Client;
  transport: StreamableHTTPClientTransport;
  /** Upstream this session was established against, to detect address changes. */
  url: string;
  idleTimer: NodeJS.Timeout | null;
}

/**
 * In-process MCP client for talking to the *user's own* hosted servers.
 *
 * Every hosted server is itself a stateful MCP Streamable HTTP endpoint, so
 * reaching one means an `initialize` handshake, an `Mcp-Session-Id` to carry on
 * every subsequent request, and a `notifications/initialized`. That is exactly
 * what the SDK's `Client` + `StreamableHTTPClientTransport` do, so this service
 * owns none of that wire detail - it owns the *session lifecycle*, which the
 * SDK deliberately leaves to the caller:
 *
 *  - one session per hosted server, created lazily and reused (a handshake per
 *    tool call would triple the round trips and leak a server-side session on
 *    the pod every time);
 *  - evicted when idle, on explicit `invalidate`, and on shutdown;
 *  - re-established once, transparently, when the pod has forgotten the
 *    session underneath us (restart, rescheduling, scale-to-zero-and-back).
 *
 * Deliberately NOT done here:
 *  - forwarding any caller credential upstream. Hosted pods are unauthenticated
 *    by design and are only reachable from inside the cluster/loopback; the
 *    authorisation decision belongs to whoever called this service, and passing
 *    a user's token to a user's own generated code would hand arbitrary
 *    AI-written source a live platform credential.
 *  - server->client push. Nothing here consumes notifications, so the
 *    standalone GET SSE stream the SDK opens after `initialized` is suppressed
 *    (see `fetchWithoutServerPush`) rather than left dangling.
 */
@Injectable()
export class HostedMcpClientService implements OnModuleDestroy {
  private readonly logger = new Logger(HostedMcpClientService.name);

  /** Live sessions, keyed by `HostedServer.serverId`. */
  private readonly sessions = new Map<string, Session>();

  /**
   * Connects currently in flight, keyed the same way. Without this, N
   * concurrent first calls for one server would each run their own
   * `initialize` and N-1 sessions would be orphaned on the pod immediately.
   */
  private readonly connecting = new Map<string, Promise<Session>>();

  private readonly idleMs: number;

  constructor(
    private readonly upstreamResolver: McpUpstreamResolver,
    private readonly configService: ConfigService,
  ) {
    const configured = Number(
      this.configService.get<string | number>('HOSTED_MCP_CLIENT_IDLE_MS', DEFAULT_IDLE_MS),
    );
    this.idleMs = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_IDLE_MS;
  }

  /**
   * Live `tools/list` from the running hosted server.
   *
   * @throws ServiceUnavailableException (from `McpUpstreamResolver`) when the
   *         server is not running or has no HTTP endpoint at all.
   */
  async listTools(server: HostedServer): Promise<HostedToolDescriptor[]> {
    return this.execute(server, 'tools/list', async (client) => {
      const result = await client.listTools(undefined, { timeout: DEFAULT_LIST_TIMEOUT_MS });
      return (result.tools ?? []).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
      }));
    });
  }

  /**
   * `tools/call` forwarded to the hosted server.
   *
   * The SDK `CallToolResult` is returned unchanged. A *tool-level* failure
   * (`isError: true`) is a successful protocol exchange and is returned, not
   * thrown - only transport/protocol failures throw.
   */
  async callTool(
    server: HostedServer,
    toolName: string,
    args: Record<string, unknown> | undefined,
    options?: { timeoutMs?: number },
  ): Promise<CallToolResult> {
    const timeout = options?.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;

    return this.execute(server, `tools/call ${toolName}`, async (client) => {
      const result = await client.callTool({ name: toolName, arguments: args }, undefined, {
        timeout,
      });
      return result as CallToolResult;
    });
  }

  /**
   * Drop any cached session for this server. Safe when none exists.
   *
   * Call after stop/start/delete: the pod behind a cached session is gone, and
   * the next caller should pay for a fresh handshake (or get the resolver's
   * ServiceUnavailableException) rather than a confusing 404 from a socket
   * pointing at a dead address.
   */
  async invalidate(serverId: string): Promise<void> {
    const session = this.sessions.get(serverId);
    if (!session) {
      return;
    }

    this.sessions.delete(serverId);
    this.logger.debug(`Invalidated MCP session for hosted server '${serverId}'`);
    await this.closeSession(serverId, session);
  }

  async onModuleDestroy(): Promise<void> {
    const entries = [...this.sessions.entries()];
    this.sessions.clear();
    this.connecting.clear();

    await Promise.all(entries.map(([serverId, session]) => this.closeSession(serverId, session)));
  }

  // --- internals ---------------------------------------------------------

  /**
   * Run one operation against a (possibly newly created) session, retrying
   * exactly once through a fresh handshake when the failure says the session
   * itself is gone.
   *
   * The resolver is consulted on EVERY call, not only on connect: a cached
   * session is a socket to a pod, and a pod that has since been stopped must
   * surface as the resolver's ServiceUnavailableException, not as whatever the
   * stale connection happens to do.
   */
  private async execute<T>(
    server: HostedServer,
    operation: string,
    run: (client: Client) => Promise<T>,
  ): Promise<T> {
    const url = this.upstreamResolver.resolve(server);
    const session = await this.acquire(server.serverId, url);

    try {
      const result = await run(session.client);
      this.scheduleEviction(server.serverId, session);
      return result;
    } catch (error) {
      if (!this.isSessionLost(error)) {
        throw error;
      }

      this.logger.log(
        `MCP session for hosted server '${server.serverId}' was lost during ${operation}; ` +
          'reconnecting once',
      );
      await this.dropIfCurrent(server.serverId, session);

      // Re-resolve: between the two attempts the server may have been stopped,
      // in which case the correct answer is the resolver's exception rather
      // than a second doomed handshake.
      const freshUrl = this.upstreamResolver.resolve(server);
      const fresh = await this.acquire(server.serverId, freshUrl);

      try {
        const result = await run(fresh.client);
        this.scheduleEviction(server.serverId, fresh);
        return result;
      } catch (retryError) {
        this.logger.warn(
          `MCP ${operation} on hosted server '${server.serverId}' failed after reconnect: ` +
            this.describe(retryError),
        );
        await this.dropIfCurrent(server.serverId, fresh);
        throw retryError;
      }
    }
  }

  private async acquire(serverId: string, url: string): Promise<Session> {
    const existing = this.sessions.get(serverId);
    if (existing) {
      if (existing.url === url) {
        this.scheduleEviction(serverId, existing);
        return existing;
      }
      // The upstream address moved (rescheduled pod, namespace change,
      // docker-run <-> kubernetes). The old session can only be wrong.
      this.sessions.delete(serverId);
      await this.closeSession(serverId, existing);
    }

    const inFlight = this.connecting.get(serverId);
    if (inFlight) {
      return inFlight;
    }

    const pending = (async () => {
      try {
        return await this.connect(serverId, url);
      } finally {
        this.connecting.delete(serverId);
      }
    })();

    this.connecting.set(serverId, pending);
    return pending;
  }

  private async connect(serverId: string, url: string): Promise<Session> {
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      fetch: this.fetchWithoutServerPush,
    });

    const client = new Client(CLIENT_INFO, { capabilities: {} });
    client.onerror = (error: Error) => {
      this.logger.warn(`MCP transport error for hosted server '${serverId}': ${error.message}`);
    };

    try {
      // connect() performs initialize + notifications/initialized.
      await client.connect(transport, { timeout: DEFAULT_LIST_TIMEOUT_MS });
    } catch (error) {
      await this.silently(() => client.close());
      throw error;
    }

    const session: Session = { client, transport, url, idleTimer: null };
    // Published before this promise settles so a concurrent caller that slips
    // past `connecting` still finds the session instead of opening a second.
    this.sessions.set(serverId, session);
    this.scheduleEviction(serverId, session);

    this.logger.debug(`Opened MCP session for hosted server '${serverId}' (${url})`);
    return session;
  }

  /**
   * Custom fetch that answers the SDK's standalone GET SSE stream with a
   * synthetic 405.
   *
   * `StreamableHTTPClientTransport` opens that stream automatically once the
   * `initialized` notification is accepted, and the SDK's own server transport
   * happily holds it open forever. Nothing in this service consumes server
   * push, so that stream would be a permanently in-flight fetch per hosted
   * server - enough to keep the Node event loop (and a Jest worker) alive. 405
   * is the spec's "this server does not offer GET SSE" answer and the transport
   * treats it as an expected, silent no-op (no error, no reconnect backoff),
   * which is why this is preferable to letting the stream open and aborting it.
   */
  private readonly fetchWithoutServerPush: FetchLike = async (url, init) => {
    if ((init?.method ?? 'GET').toUpperCase() === 'GET') {
      return new Response(null, { status: 405, statusText: 'Method Not Allowed' });
    }
    return fetch(url as string | URL, init);
  };

  private scheduleEviction(serverId: string, session: Session): void {
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
    }

    session.idleTimer = setTimeout(() => {
      if (this.sessions.get(serverId) !== session) {
        return;
      }
      this.sessions.delete(serverId);
      this.logger.debug(
        `Evicted idle MCP session for hosted server '${serverId}' after ${this.idleMs}ms`,
      );
      void this.closeSession(serverId, session);
    }, this.idleMs);

    // Never a reason to keep the process alive just to expire a cache entry.
    session.idleTimer.unref?.();
  }

  /** Remove a session only if it is still the cached one (never a successor). */
  private async dropIfCurrent(serverId: string, session: Session): Promise<void> {
    if (this.sessions.get(serverId) === session) {
      this.sessions.delete(serverId);
    }
    await this.closeSession(serverId, session);
  }

  private async closeSession(serverId: string, session: Session): Promise<void> {
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }

    // Best effort DELETE so the pod can free its side of the session too.
    // Bounded by TERMINATE_GRACE_MS and then unconditionally superseded by
    // close(), which aborts the transport's AbortController and therefore any
    // DELETE still in flight - so a wedged pod cannot stall shutdown.
    await this.silently(() =>
      Promise.race([session.transport.terminateSession(), this.grace(TERMINATE_GRACE_MS)]),
    );
    await this.silently(() => session.client.close());
  }

  private grace(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  }

  private async silently(action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
    } catch {
      // Teardown is best effort by construction: the usual reason it fails is
      // that the thing being torn down is already gone.
    }
  }

  /**
   * Whether a failure means "the server no longer knows this session", i.e. a
   * fresh handshake is a plausible fix.
   *
   * 404 (`-32001 Session not found`) is what the SDK's own server transport
   * returns. 400 is what the *generated* server template returns for the same
   * situation - it dispatches on its own session map before the transport ever
   * sees the request - so both have to count, and the message is checked in the
   * 400 case so an ordinary malformed-request 400 is not retried forever.
   * Connection-level failures count too: a restarted pod refuses the old socket
   * long before it can answer with a status code.
   */
  private isSessionLost(error: unknown): boolean {
    if (error instanceof StreamableHTTPError) {
      if (error.code === 404) {
        return true;
      }
      if (error.code === 400 && /session/i.test(error.message ?? '')) {
        return true;
      }
    }

    const message = this.describe(error);
    if (
      /session (?:not found|expired|has been terminated)|no valid session|-32001/i.test(message)
    ) {
      return true;
    }

    return /ECONNREFUSED|ECONNRESET|EPIPE|ETIMEDOUT|EHOSTUNREACH|socket hang up|fetch failed|Not connected/i.test(
      message,
    );
  }

  private describe(error: unknown): string {
    if (error instanceof Error) {
      const cause = (error as { cause?: unknown }).cause;
      const causeText =
        cause instanceof Error
          ? ` (cause: ${cause.message})`
          : typeof cause === 'string'
            ? ` (cause: ${cause})`
            : '';
      return `${error.message}${causeText}`;
    }
    return String(error);
  }
}
