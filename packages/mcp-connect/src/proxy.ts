import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { isInitializeRequest, isJSONRPCResponse } from '@modelcontextprotocol/sdk/types.js';

import { formatTransportError } from './errors';

export interface ProxyLogger {
  /** Diagnostics/progress. MUST be wired to stderr - never stdout. */
  info(message: string): void;
  /** Errors. MUST be wired to stderr - never stdout. */
  error(message: string): void;
}

/**
 * A faithful, bidirectional stdio<->Streamable HTTP proxy.
 *
 * `local` is the side facing Claude Desktop (a StdioServerTransport in
 * production); `remote` is the side facing the hosted MCP server (a
 * StreamableHTTPClientTransport in production). Both just implement the
 * SDK's `Transport` interface, so this class only forwards JSON-RPC messages
 * between them - it never parses or acts on MCP semantics itself, which is
 * exactly what makes it a transparent proxy rather than a reimplementation
 * of the protocol.
 *
 * The one exception: it watches for the `initialize` response passing
 * through so it can call `remote.setProtocolVersion()` with the version the
 * server actually negotiated, exactly as the SDK's own `Client` class would
 * do internally. Skipping this would leave `remote`'s negotiated-version
 * header unset for every request after the first.
 */
export class McpProxy {
  private closed = false;
  private pendingInitializeId: string | number | null = null;

  constructor(
    private readonly local: Transport,
    private readonly remote: Transport,
    private readonly logger: ProxyLogger,
    private readonly remoteUrl: string,
  ) {}

  async start(): Promise<void> {
    this.wire();

    // Start the remote (HTTP) side first: if the URL is fundamentally wrong
    // (unparseable, etc.) this is where a synchronous throw would surface,
    // before we've committed to owning Claude Desktop's stdio streams.
    await this.remote.start();
    await this.local.start();

    this.logger.info(`mcp-connect: proxying stdio <-> ${this.remoteUrl}`);
  }

  private wire(): void {
    this.local.onmessage = (message: JSONRPCMessage) => {
      if (isInitializeRequest(message)) {
        // isInitializeRequest narrows to the bare InitializeRequest shape
        // (method + params), which doesn't carry the JSON-RPC envelope's
        // `id` - but the JSONRPCMessage we were actually passed does.
        this.pendingInitializeId = (message as unknown as { id: string | number | null }).id;
      }

      this.remote.send(message).catch((error) => {
        this.logger.error(formatTransportError(error, this.remoteUrl));
      });
    };

    this.remote.onmessage = (message: JSONRPCMessage) => {
      this.captureNegotiatedProtocolVersion(message);

      this.local.send(message).catch((error) => {
        this.logger.error(
          `Failed writing response to Claude Desktop over stdio: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    };

    this.remote.onerror = (error: Error) => {
      this.logger.error(formatTransportError(error, this.remoteUrl));
    };

    this.local.onerror = (error: Error) => {
      this.logger.error(`stdio transport error: ${error.message}`);
    };

    this.remote.onclose = () => {
      this.logger.info(`mcp-connect: connection to ${this.remoteUrl} closed.`);
      void this.close();
    };

    this.local.onclose = () => {
      void this.close();
    };
  }

  private captureNegotiatedProtocolVersion(message: JSONRPCMessage): void {
    if (this.pendingInitializeId === null || !isJSONRPCResponse(message)) {
      return;
    }
    if (message.id !== this.pendingInitializeId) {
      return;
    }

    this.pendingInitializeId = null;

    const result = (message as { result?: { protocolVersion?: unknown } }).result;
    const negotiated = result?.protocolVersion;
    if (typeof negotiated === 'string' && this.remote.setProtocolVersion) {
      this.remote.setProtocolVersion(negotiated);
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;

    await Promise.allSettled([this.remote.close(), this.local.close()]);
  }
}
