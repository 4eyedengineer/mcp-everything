/**
 * Resolves the base URL of a hosted MCP server from user input, and derives
 * the MCP/health endpoints from it.
 *
 * ---------------------------------------------------------------------------
 * THE URL SHAPE CHANGED: PER-SERVER SUBDOMAIN -> ONE GATEWAY ORIGIN
 * ---------------------------------------------------------------------------
 * This used to build `https://${serverId}.${domain}`. That shape is gone,
 * because nothing ever served it: `ManifestGeneratorService` creates only a
 * ClusterIP Service and deliberately no Ingress, so there was no wildcard DNS
 * record, no certificate and no route behind those hostnames. (Per-server certs
 * were not merely unbuilt but unworkable - Let's Encrypt allows 50 certificates
 * per registered domain per week, so 50 deploys would have taken hosting down
 * for a week.)
 *
 * Hosted servers are now reached through a gateway on the platform's own
 * origin, which authenticates the caller, meters the request and forwards it to
 * the pod:
 *
 *   https://<platform-host>/api/hosting/servers/<serverId>/mcp
 *
 * So a bare server ID expands to a PATH on a shared host, not a subdomain.
 * `--domain`/`MCP_HOSTING_DOMAIN` are correspondingly replaced by a platform
 * base URL; the old option names are still accepted and interpreted as the
 * platform origin, so existing config files keep working.
 *
 * Because the gateway authenticates, an API key is now REQUIRED rather than
 * decorative - see `getApiKey()` and the `--api-key` flag.
 * ---------------------------------------------------------------------------
 */

/**
 * Default platform origin. This is the MCP Everything backend, not a per-server
 * host - contrast the old default, "mcp.example.com", which was a wildcard
 * domain suffix.
 */
export const DEFAULT_PLATFORM_URL = 'https://api.mcpeverything.com';

/** Path prefix the gateway serves hosted MCP servers on. */
export const GATEWAY_PATH_PREFIX = '/api/hosting/servers';

/**
 * @deprecated Retained so a `domain` in an existing `~/.mcpeverything/config.json`
 * still resolves to something sensible. Prefer a full platform URL.
 */
export const DEFAULT_DOMAIN = 'mcp.example.com';

const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const SERVER_ID_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i;

/**
 * Turn a bare domain suffix into a usable platform origin.
 *
 * A legacy `--domain mcp.example.com` (or `MCP_HOSTING_DOMAIN`) named a
 * wildcard suffix, not a host that ever answered. Treating it as an https
 * origin is the closest honest interpretation and keeps old configs pointing at
 * the same deployment's front door.
 */
export function normalizePlatformUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) {
    return DEFAULT_PLATFORM_URL;
  }
  return URL_SCHEME_RE.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/**
 * Resolve the base URL (no trailing slash, no /mcp suffix) of a hosted MCP
 * server from a CLI argument that is either a full URL or a bare server ID.
 *
 * A full URL is passed through untouched - that is what lets a user point at a
 * locally-running server (`http://localhost:20123`) or a self-hosted platform
 * without this function needing to know either shape.
 *
 * @throws Error with a human-readable message if `arg` is neither a URL nor
 *   something that looks like a valid server ID.
 */
export function resolveServerBaseUrl(
  arg: string,
  platformUrl: string = DEFAULT_PLATFORM_URL,
): string {
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

  return `${normalizePlatformUrl(platformUrl)}${GATEWAY_PATH_PREFIX}/${trimmed}`;
}

export function mcpEndpoint(baseUrl: string): string {
  return `${baseUrl}/mcp`;
}

export function healthEndpoint(baseUrl: string): string {
  return `${baseUrl}/health`;
}

/**
 * Whether `GET <base>/health` is meaningful for this base URL.
 *
 * A generated MCP server serves `/health` next to `/mcp`, so the pre-flight
 * check is useful when talking to one directly. The gateway does not: it
 * exposes exactly one route per server (`/mcp`), because a health endpoint
 * there would either need its own authentication or become an unauthenticated
 * probe for which server ids exist. Calling it anyway would produce a
 * confusing 404 warning on every startup, so callers skip it.
 */
export function supportsHealthCheck(baseUrl: string): boolean {
  return !baseUrl.includes(GATEWAY_PATH_PREFIX);
}
