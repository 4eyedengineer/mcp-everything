import { Injectable, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import * as http from 'node:http';
import * as https from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';

/**
 * Headers that are meaningful only for a single hop and must never be copied
 * across a proxy (RFC 9110 s7.6.1). `content-length` is handled separately:
 * we recompute it on the request side and drop it on the response side,
 * because the response is re-framed as chunked.
 */
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Client -> upstream. An allowlist, not a denylist: the caller's credential
 * (`authorization`, `x-api-key`, `cookie`) authenticates them to the PLATFORM,
 * and forwarding it would hand a user's platform key to an arbitrary piece of
 * AI-generated third-party code running in the hosted container.
 */
const FORWARDED_REQUEST_HEADERS = [
  'content-type',
  'accept',
  'accept-language',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
  'user-agent',
];

/**
 * Upstream -> client. Also an allowlist, so a hosted server cannot inject
 * `set-cookie` into the platform's origin (the gateway shares an origin with
 * the API and the session it issues) or override CORS headers.
 */
const FORWARDED_RESPONSE_HEADERS = [
  'content-type',
  'mcp-session-id',
  'mcp-protocol-version',
  'cache-control',
  'retry-after',
  'www-authenticate',
];

/** The Accept value a real MCP Streamable HTTP server requires; see ensureAccept(). */
const REQUIRED_ACCEPT = 'application/json, text/event-stream';

export interface McpProxyResult {
  statusCode: number;
  /** True when the upstream replied with an SSE stream rather than a single JSON body. */
  streamed: boolean;
}

@Injectable()
export class McpProxyService {
  private readonly logger = new Logger(McpProxyService.name);

  /**
   * How long to wait for the upstream to produce RESPONSE HEADERS.
   *
   * Deliberately not an overall request deadline: a Streamable HTTP `GET /mcp`
   * is a long-lived server->client stream that is *supposed* to stay open
   * indefinitely, so any timer that keeps running after headers arrive would
   * sever healthy sessions. Once headers are through, the connection lives
   * until one side closes it.
   */
  static readonly UPSTREAM_HEADERS_TIMEOUT_MS = 30_000;

  /** How long to wait for the TCP connection itself. */
  static readonly UPSTREAM_CONNECT_TIMEOUT_MS = 5_000;

  /**
   * Forward one MCP request to `upstreamUrl` and stream the reply straight back.
   *
   * ---------------------------------------------------------------------------
   * WHY THIS IS HAND-ROLLED `http.request` + `pipe` AND NOT A NEST/AXIOS CALL
   * ---------------------------------------------------------------------------
   * MCP Streamable HTTP answers a POST with EITHER a single JSON object OR a
   * `text/event-stream` whose whole purpose is incremental delivery. Any client
   * that resolves a promise with a complete body (axios, `fetch().then(r =>
   * r.text())`, Nest's HttpService) turns the second case into a batch response
   * that arrives all at once when the stream ends - which "works" for a short
   * tool call and silently breaks progress notifications, sampling, and every
   * long-running tool.
   *
   * So: the upstream `IncomingMessage` is piped directly into the Express
   * `Response`, chunk by chunk, and the controller returns nothing (`@Res()`
   * without `passthrough`, so Nest never touches the response). Specific
   * anti-buffering measures, each load-bearing:
   *
   *   1. `pipe()` - each upstream chunk becomes a `res.write()` as it lands.
   *   2. `flushHeaders()` immediately after `writeHead`, so the client sees the
   *      200 + content-type before the first event rather than with it.
   *   3. `accept-encoding: identity` on the way out. A gzip-encoding upstream
   *      would be free to hold bytes in its compressor's window, reintroducing
   *      buffering below the layer this code can see.
   *   4. `setNoDelay(true)` on both sockets, disabling Nagle - otherwise small
   *      SSE frames get coalesced with up to ~40ms of added latency each.
   *   5. `X-Accel-Buffering: no` on event-streams, so an nginx/ingress in front
   *      of the backend does not re-buffer what we just took care not to.
   * ---------------------------------------------------------------------------
   */
  proxy(
    req: Request,
    res: Response,
    upstreamUrl: string,
    serverId: string,
  ): Promise<McpProxyResult> {
    return new Promise<McpProxyResult>((resolve) => {
      const target = new URL(upstreamUrl);
      const transport = target.protocol === 'https:' ? https : http;
      const body = this.requestBody(req);

      let settled = false;
      const settle = (result: McpProxyResult) => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };

      const upstreamReq: ClientRequest = transport.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || (target.protocol === 'https:' ? 443 : 80),
          path: `${target.pathname}${target.search}`,
          method: req.method,
          headers: this.buildRequestHeaders(req, body),
        },
        (upstreamRes: IncomingMessage) => {
          clearTimeout(headersTimer);
          this.pipeResponse(upstreamRes, res, serverId, settle);
        },
      );

      const headersTimer = setTimeout(() => {
        upstreamReq.destroy(
          new Error(
            `Upstream did not send response headers within ` +
              `${McpProxyService.UPSTREAM_HEADERS_TIMEOUT_MS}ms`,
          ),
        );
      }, McpProxyService.UPSTREAM_HEADERS_TIMEOUT_MS);
      headersTimer.unref?.();

      upstreamReq.setNoDelay(true);
      upstreamReq.setTimeout(McpProxyService.UPSTREAM_CONNECT_TIMEOUT_MS, () => {
        // Fires only while nothing has been received yet; once the upstream is
        // streaming, `socket.setTimeout` is cleared in pipeResponse().
        upstreamReq.destroy(
          new Error(
            `Could not connect to the hosted server within ` +
              `${McpProxyService.UPSTREAM_CONNECT_TIMEOUT_MS}ms`,
          ),
        );
      });

      upstreamReq.on('error', (error: Error) => {
        clearTimeout(headersTimer);
        this.failGateway(res, serverId, upstreamUrl, error, settle);
      });

      // If the client hangs up (Claude Desktop quits, tab closed), tear down
      // the upstream leg too rather than leaking an open SSE connection.
      const abortUpstream = () => upstreamReq.destroy();
      res.on('close', abortUpstream);

      if (body) {
        upstreamReq.end(body);
      } else {
        upstreamReq.end();
      }
    });
  }

  /**
   * The exact bytes the client sent.
   *
   * `main.ts` bootstraps with `rawBody: true`, so body-parser stashes the
   * unparsed buffer on the request. Forwarding those bytes verbatim - rather
   * than `JSON.stringify(req.body)` - keeps the JSON-RPC payload byte-identical,
   * which matters because re-serialising can reorder keys and change the
   * content-length of a payload the upstream may be framing or checking.
   */
  private requestBody(req: Request): Buffer | undefined {
    const raw = (req as Request & { rawBody?: Buffer }).rawBody;
    if (raw && raw.length > 0) {
      return raw;
    }
    return undefined;
  }

  private buildRequestHeaders(req: Request, body?: Buffer): http.OutgoingHttpHeaders {
    const headers: http.OutgoingHttpHeaders = {};

    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = req.headers[name];
      if (value !== undefined && !HOP_BY_HOP_HEADERS.has(name)) {
        headers[name] = value;
      }
    }

    headers['accept'] = this.ensureAccept(req.headers['accept']);

    // See anti-buffering measure (3) in proxy()'s doc comment.
    headers['accept-encoding'] = 'identity';

    // No `host` entry is set at all. The upstream is addressed by service DNS /
    // loopback, so Node must derive Host from the target URL; forwarding the
    // client's Host would be wrong. Note this must be an ABSENT key rather than
    // an explicit `undefined` - `http.request` throws
    // ERR_HTTP_INVALID_HEADER_VALUE on an undefined value rather than ignoring
    // it. FORWARDED_REQUEST_HEADERS omits `host`, so nothing to remove.

    if (body) {
      headers['content-length'] = String(body.length);
    }

    return headers;
  }

  /**
   * MCP Streamable HTTP requires the client to advertise BOTH `application/json`
   * and `text/event-stream`; a real server answers 406 Not Acceptable if either
   * is missing. Browsers and intermediaries rewrite Accept freely (`*​/*`), so
   * the gateway asserts the correct value rather than trusting what arrived.
   */
  private ensureAccept(incoming: string | string[] | undefined): string {
    const value = Array.isArray(incoming) ? incoming.join(', ') : incoming;

    if (!value) {
      return REQUIRED_ACCEPT;
    }

    const lower = value.toLowerCase();
    const hasJson = lower.includes('application/json') || lower.includes('*/*');
    const hasEventStream = lower.includes('text/event-stream');

    if (hasJson && hasEventStream) {
      return value;
    }

    return REQUIRED_ACCEPT;
  }

  private pipeResponse(
    upstreamRes: IncomingMessage,
    res: Response,
    serverId: string,
    settle: (result: McpProxyResult) => void,
  ): void {
    const statusCode = upstreamRes.statusCode ?? 502;
    const contentType = String(upstreamRes.headers['content-type'] ?? '');
    const isEventStream = contentType.toLowerCase().includes('text/event-stream');

    const headers: Record<string, string> = {};
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = upstreamRes.headers[name];
      if (value !== undefined && !HOP_BY_HOP_HEADERS.has(name)) {
        headers[name] = Array.isArray(value) ? value.join(', ') : String(value);
      }
    }

    if (isEventStream) {
      headers['cache-control'] = 'no-cache, no-transform';
      headers['connection'] = 'keep-alive';
      headers['x-accel-buffering'] = 'no';
    }

    // A long-lived stream must not be killed by the connect timer set in proxy().
    upstreamRes.socket?.setTimeout(0);
    upstreamRes.socket?.setNoDelay(true);
    res.socket?.setNoDelay(true);

    res.writeHead(statusCode, headers);
    // Push the status line + headers out now, ahead of any body bytes, so an
    // SSE client can start reading immediately instead of waiting for the
    // first event to flush the header block.
    res.flushHeaders();

    upstreamRes.on('error', (error: Error) => {
      this.logger.warn(`Upstream stream error for hosted server ${serverId}: ${error.message}`);
      res.destroy();
      settle({ statusCode, streamed: isEventStream });
    });

    upstreamRes.on('end', () => settle({ statusCode, streamed: isEventStream }));

    // The whole point of the gateway: chunk in, chunk out, nothing accumulated.
    upstreamRes.pipe(res);
  }

  /**
   * Upstream unreachable/failed before any bytes were written. Answers 502 with
   * an explanation instead of leaving the caller to hang until their own
   * timeout - `mcp-connect` surfaces this text verbatim to the user.
   */
  private failGateway(
    res: Response,
    serverId: string,
    upstreamUrl: string,
    error: Error,
    settle: (result: McpProxyResult) => void,
  ): void {
    this.logger.error(
      `MCP gateway could not reach hosted server ${serverId} at ${upstreamUrl}: ${error.message}`,
    );

    if (!res.headersSent) {
      res.status(502).json({
        error: 'Bad Gateway',
        message:
          `The hosted MCP server '${serverId}' could not be reached: ${error.message}. ` +
          'It may still be starting up, or it may have crashed - check the server logs.',
        serverId,
      });
    } else {
      // Already streaming; the only honest signal left is to cut the connection.
      res.destroy();
    }

    settle({ statusCode: 502, streamed: false });
  }
}
