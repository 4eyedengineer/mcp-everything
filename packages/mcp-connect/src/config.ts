import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface Config {
  /** Full base URL of a hosted MCP server, e.g. "https://my-server.mcp.example.com". */
  baseUrl?: string;
  /**
   * Origin of the MCP Everything backend, whose gateway fronts every hosted
   * server: server ID "stripe-abc123k9" becomes
   * "<platformUrl>/api/hosting/servers/stripe-abc123k9". Mirrors
   * MCP_GATEWAY_PUBLIC_URL in packages/backend/src/hosting/hosting.service.ts.
   */
  platformUrl?: string;
  /**
   * @deprecated Legacy wildcard-domain suffix from when each server had its own
   * subdomain. Still read (and interpreted as a platform origin) so existing
   * config files keep working; prefer `platformUrl`.
   */
  domain?: string;
  apiKeys?: Record<string, string>;
}

const CONFIG_PATHS = [
  path.join(os.homedir(), '.mcpeverything', 'config.json'),
  path.join(os.homedir(), '.config', 'mcpeverything', 'config.json'),
];

export function loadConfig(): Config {
  for (const configPath of CONFIG_PATHS) {
    if (fs.existsSync(configPath)) {
      try {
        const content = fs.readFileSync(configPath, 'utf-8');
        return JSON.parse(content);
      } catch (error) {
        // Invalid config file, continue to next
        console.error(`Warning: Could not parse config at ${configPath}`);
      }
    }
  }

  return {};
}

export function saveConfig(config: Config): void {
  const configDir = path.join(os.homedir(), '.mcpeverything');

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  const configPath = path.join(configDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

export function getConfigPath(): string {
  return path.join(os.homedir(), '.mcpeverything', 'config.json');
}
