/**
 * Turns whatever the SDK's StreamableHTTPClientTransport (or a plain fetch)
 * throws into a clear, actionable message for a human debugging a broken
 * connection - this is a CLI, there's no other UI to surface these in.
 *
 * Sources of error this has to handle in practice:
 *   - Node's fetch (undici) throwing `TypeError: fetch failed` with a
 *     `.cause` carrying the real errno code (ECONNREFUSED, ENOTFOUND, ...).
 *   - `StreamableHTTPError` (from @modelcontextprotocol/sdk/client/
 *     streamableHttp.js), which carries the HTTP status as `.code`.
 *   - Everything else, generically.
 */

interface ErrnoLike {
  code?: string;
}

function errnoCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  const direct = (error as ErrnoLike).code;
  if (direct) {
    return direct;
  }
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    return (cause as ErrnoLike).code;
  }
  return undefined;
}

/** Present on @modelcontextprotocol/sdk's StreamableHTTPError. */
function httpStatusCode(error: unknown): number | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'number') {
      return code;
    }
  }
  return undefined;
}

export function formatTransportError(error: unknown, url: string): string {
  const errno = errnoCode(error);
  const message = error instanceof Error ? error.message : String(error);

  switch (errno) {
    case 'ECONNREFUSED':
      return `Cannot reach MCP server at ${url} - connection refused. Is the server running, and is the URL/port correct?`;
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `Cannot resolve host for ${url} - check the server ID/domain (DNS lookup failed).`;
    case 'ECONNRESET':
      return `Connection to ${url} was reset while talking to the server - it may have crashed or timed out mid-request.`;
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
      return `Timed out connecting to ${url} - the server may be unreachable or overloaded.`;
    default:
      break;
  }

  const status = httpStatusCode(error);
  if (status !== undefined) {
    switch (status) {
      case 404:
        return `No MCP server found at ${url} (HTTP 404). Check the server ID/URL - this endpoint doesn't exist.`;
      case 406:
        return (
          `Server at ${url} rejected the request with HTTP 406 Not Acceptable - this means the ` +
          `Accept header didn't include both "application/json" and "text/event-stream". The ` +
          `bundled SDK client sets this automatically, so seeing this likely means a proxy/gateway ` +
          `in front of the server is stripping headers.`
        );
      case 401:
      case 403:
        return (
          `Authentication failed for ${url} (HTTP ${status}). If this server requires an API key, ` +
          `set MCPEVERYTHING_API_KEY or pass --api-key.`
        );
      case 400:
        if (/session/i.test(message)) {
          return (
            `Session rejected by ${url} (HTTP 400) - it has likely expired or the server restarted. ` +
            `Restart mcp-connect to establish a fresh session.`
          );
        }
        return `Bad request to ${url} (HTTP 400): ${message}`;
      case 500:
      case 502:
      case 503:
      case 504:
        return `MCP server at ${url} returned HTTP ${status} - the server itself is failing or unavailable: ${message}`;
      default:
        return `MCP server at ${url} returned HTTP ${status}: ${message}`;
    }
  }

  const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
  const causeMessage = cause instanceof Error ? cause.message : undefined;

  return causeMessage
    ? `Error communicating with ${url}: ${message} (${causeMessage})`
    : `Error communicating with ${url}: ${message}`;
}
