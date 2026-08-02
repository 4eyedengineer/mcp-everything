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
}

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
 */
export function buildClaudeDesktopConfig(
  serverName: string,
  serverId: string
): ClaudeDesktopConfig {
  return {
    mcpServers: {
      [slugifyServerName(serverName)]: {
        command: 'mcp-connect',
        args: [serverId]
      }
    }
  };
}

/**
 * Same as {@link buildClaudeDesktopConfig}, pretty-printed as the JSON
 * snippet shown/copied in the UI.
 */
export function buildClaudeDesktopConfigJson(serverName: string, serverId: string): string {
  return JSON.stringify(buildClaudeDesktopConfig(serverName, serverId), null, 2);
}
