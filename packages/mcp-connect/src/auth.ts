import { loadConfig } from './config';

/**
 * Get the API key for a given server ID.
 * Resolution order:
 * 1. MCPEVERYTHING_API_KEY environment variable
 * 2. Server-specific key from config file
 * 3. Default key from config file
 */
export function getApiKey(serverId: string): string | undefined {
  // Check environment variable first
  const envKey = process.env.MCPEVERYTHING_API_KEY;
  if (envKey) {
    return envKey;
  }

  // Check config file
  const config = loadConfig();

  // Check for server-specific key
  if (config.apiKeys?.[serverId]) {
    return config.apiKeys[serverId];
  }

  // Check for default key
  return config.apiKeys?.['default'];
}
