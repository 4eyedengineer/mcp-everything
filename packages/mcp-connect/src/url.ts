/**
 * Resolves the base URL of a hosted MCP server from user input, and derives
 * the MCP/health endpoints from it.
 *
 * The real URL shape (confirmed by reading packages/backend/src/hosting/
 * hosting.service.ts and packages/backend/src/hosting/services/
 * manifest-generator.service.ts, not guessed) is:
 *
 *   - Default (kubernetes) hosting mode: `https://${serverId}.${domain}`
 *     where `serverId` is a DNS-label subdomain (see HostingService
 *     .generateServerId / .deployToCloud), NOT a path segment appended to a
 *     shared host - `${baseUrl}/${serverId}` (what the old bespoke transport
 *     assumed) is the wrong shape entirely.
 *   - `domain` defaults to the backend's own MCP_HOSTING_DOMAIN default,
 *     "mcp.example.com" (see HostingService constructor).
 *   - docker-run hosting mode instead assigns a plain
 *     `http://localhost:<port>` endpointUrl with no subdomain at all - so
 *     any URL supplied as-is (arg contains "://") is passed through
 *     unchanged rather than reinterpreted.
 *
 * Either way, the server always exposes `POST /mcp` (Streamable HTTP) and
 * `GET /health` off of that base.
 */

export const DEFAULT_DOMAIN = 'mcp.example.com';

const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const SERVER_ID_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i;

/**
 * Resolve the base URL (no trailing slash, no /mcp or /health suffix) of a
 * hosted MCP server from a CLI argument that is either a full URL or a bare
 * server ID.
 *
 * @throws Error with a human-readable message if `arg` is neither a URL nor
 *   something that looks like a valid server ID.
 */
export function resolveServerBaseUrl(arg: string, domain: string = DEFAULT_DOMAIN): string {
  const trimmed = arg.trim();

  if (URL_SCHEME_RE.test(trimmed)) {
    return trimmed.replace(/\/+$/, '');
  }

  if (!SERVER_ID_RE.test(trimmed)) {
    throw new Error(
      `"${arg}" is neither a URL (must start with "https://" or "http://") nor a valid ` +
        'server ID (lowercase letters, digits, and hyphens, e.g. "stripe-abc123k9").',
    );
  }

  return `https://${trimmed}.${domain}`;
}

export function mcpEndpoint(baseUrl: string): string {
  return `${baseUrl}/mcp`;
}

export function healthEndpoint(baseUrl: string): string {
  return `${baseUrl}/health`;
}
