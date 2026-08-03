/**
 * Single source of truth for the Claude Desktop MCP config snippet users are
 * told to paste into `claude_desktop_config.json`.
 *
 * Claude Desktop can only ever launch local stdio processes - it has no
 * built-in way to dial a remote URL. A server hosted by MCP Everything
 * (Streamable HTTP) is reached through the local `mcp-connect` proxy, which
 * takes the hosted server's `serverId` as its only argument and bridges
 * stdio <-> Streamable HTTP on the user's behalf. That means the config
 * never needs (or should show) a `transport`/`url` pair - `serverId` is the
 * only thing the proxy needs to find the right server.
 *
 * Previously `deploy-progress.component.ts` and
 * `server-management-card.component.ts` each hand-rolled their own version
 * of this object and had drifted: one emitted a legacy `{ transport: 'sse',
 * url }` shape (a deprecated MCP transport pointed at a fabricated URL), the
 * other emitted this `mcp-connect` shape. This utility is the only place
 * that shape is defined, so the two screens can't diverge again.
 */

/** A single entry under `mcpServers` in `claude_desktop_config.json`. */
export interface ClaudeDesktopMcpServerEntry {
  command: string;
  args: string[];
  /**
   * Present because the MCP gateway authenticates every request. `mcp-connect`
   * reads `MCPEVERYTHING_API_KEY` and forwards it as `Authorization: Bearer`.
   * Claude Desktop passes `env` through to the spawned process.
   */
  env?: Record<string, string>;
}

/**
 * Placeholder written into the generated snippet in place of a real key.
 *
 * A per-server key is shown exactly once, at creation, and is unrecoverable
 * afterwards - so this utility cannot know it, and must not imply the config
 * works unedited. The placeholder is deliberately conspicuous.
 */
export const API_KEY_PLACEHOLDER = 'mcps_REPLACE_WITH_YOUR_API_KEY';

export interface ClaudeDesktopConfig {
  mcpServers: Record<string, ClaudeDesktopMcpServerEntry>;
}

/**
 * Turn a human-readable server name into the key Claude Desktop's config
 * uses to label the entry (lowercase, spaces collapsed to single hyphens).
 */
export function slugifyServerName(serverName: string): string {
  return serverName.trim().toLowerCase().replace(/\s+/g, '-');
}

/**
 * Build the Claude Desktop config object for a hosted MCP server, addressed
 * via the local `mcp-connect` proxy.
 *
 * `serverId` remains the only positional argument: `mcp-connect` expands it to
 * the gateway URL (`<platform>/api/hosting/servers/<serverId>/mcp`) itself, so
 * the snippet does not hard-code a host and does not go stale if the platform
 * origin changes.
 *
 * @param apiKey the server's per-server key. Omitted callers get
 *   {@link API_KEY_PLACEHOLDER}, because the real key is shown only once at
 *   creation time and cannot be looked up afterwards.
 */
export function buildClaudeDesktopConfig(
  serverName: string,
  serverId: string,
  apiKey: string = API_KEY_PLACEHOLDER
): ClaudeDesktopConfig {
  return {
    mcpServers: {
      [slugifyServerName(serverName)]: {
        command: 'mcp-connect',
        args: [serverId],
        env: {
          MCPEVERYTHING_API_KEY: apiKey
        }
      }
    }
  };
}

/**
 * Same as {@link buildClaudeDesktopConfig}, pretty-printed as the JSON
 * snippet shown/copied in the UI.
 */
export function buildClaudeDesktopConfigJson(
  serverName: string,
  serverId: string,
  apiKey?: string
): string {
  return JSON.stringify(buildClaudeDesktopConfig(serverName, serverId, apiKey), null, 2);
}

/**
 * One-line instruction to show beside the snippet.
 *
 * Users previously needed no credential at all, so a bare snippet was
 * self-sufficient. It no longer is: pasting it unedited yields HTTP 401. Any
 * screen rendering the snippet should render this too.
 */
export function claudeDesktopApiKeyHint(serverId: string): string {
  return (
    `Replace ${API_KEY_PLACEHOLDER} with an API key for this server. ` +
    `Create one from the server's "API keys" action (or POST /api/hosting/servers/${serverId}/keys) - ` +
    'the key is displayed only once, so copy it immediately.'
  );
}
