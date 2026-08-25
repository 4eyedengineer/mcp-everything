#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { loadConfig } from './config';
import { getApiKey } from './auth';
import {
  resolveServerBaseUrl,
  mcpEndpoint,
  healthEndpoint,
  supportsHealthCheck,
  normalizePlatformUrl,
  DEFAULT_PLATFORM_URL,
} from './url';
import { formatTransportError } from './errors';
import { McpProxy, ProxyLogger } from './proxy';

const HEALTH_CHECK_TIMEOUT_MS = 5000;

// All logging - info AND error - goes to stderr. stdout is the JSON-RPC
// channel to Claude Desktop; a single stray console.log() there corrupts
// every message that follows it.
const logger: ProxyLogger = {
  info: (message: string) => console.error(message),
  error: (message: string) => console.error(message),
};

interface CliArgs {
  serverArg?: string;
  url?: string;
  /** Platform origin hosting the MCP gateway. `--domain` is a legacy alias. */
  platformUrl?: string;
  apiKey?: string;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { help: false };
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--url':
        args.url = argv[++i];
        break;
      // --platform-url is the accurate name now that a bare server ID expands
      // to a path on one gateway origin rather than its own subdomain.
      case '--platform-url':
      case '--domain':
        args.platformUrl = argv[++i];
        break;
      case '--api-key':
        args.apiKey = argv[++i];
        break;
      default:
        positionals.push(arg);
    }
  }

  args.serverArg = positionals[0];
  return args;
}

function printUsage(): void {
  console.error(`
Usage: mcp-connect <server-id-or-url> [options]

Connects Claude Desktop (over stdio) to a cloud-hosted MCP server that
speaks the real MCP Streamable HTTP protocol: POST /mcp, SSE-framed
responses, Mcp-Session-Id, protocol version 2025-11-25.

  Claude Desktop <--stdio--> mcp-connect <--HTTPS--> MCP Everything gateway
                                                       |
                                                       +--> hosted server

Hosted servers are reached through the platform gateway on one origin
(https://<platform>/api/hosting/servers/<server-id>/mcp), not on a
per-server subdomain. The gateway authenticates every request, so an API
key is REQUIRED - see --api-key below.

Arguments:
  server-id-or-url   Either:
                       - a bare server ID, e.g. stripe-abc123k9, expanded to
                         <platform-url>/api/hosting/servers/<id>, or
                       - a full base URL, used verbatim, e.g. for a server you
                         are running yourself (http://localhost:20123)

Options:
  --url <url>        Same as passing a full URL positionally. Takes priority
                      over the positional argument and $MCPEVERYTHING_BASE_URL.
  --platform-url <u> Origin of the MCP Everything backend, used when the
                      argument is a bare server ID.
                      Default: $MCPEVERYTHING_PLATFORM_URL, then
                      "${DEFAULT_PLATFORM_URL}".
  --domain <domain>  Deprecated alias for --platform-url. A bare domain is
                      interpreted as "https://<domain>".
  --api-key <key>    Per-server key (starts with "mcps_"), sent as
                      "Authorization: Bearer <key>". Create one with
                      POST /api/hosting/servers/<server-id>/keys. Required
                      unless you are the server's owner and are supplying a
                      session token instead.
  -h, --help         Show this help.

Environment Variables:
  MCPEVERYTHING_API_KEY       API key for authentication (same as --api-key)
  MCPEVERYTHING_BASE_URL      Full base URL; overrides the positional argument
  MCPEVERYTHING_PLATFORM_URL  Platform origin (see --platform-url)
  MCP_HOSTING_DOMAIN          Deprecated; treated as a platform origin

Config File (~/.mcpeverything/config.json or ~/.config/mcpeverything/config.json):
  {
    "platformUrl": "https://api.mcpeverything.com",
    "apiKeys": {
      "default": "mcps_your-default-key",
      "stripe-abc123k9": "mcps_server-specific-key"
    }
  }

Examples:
  MCPEVERYTHING_API_KEY=mcps_xxx mcp-connect stripe-abc123k9
  mcp-connect stripe-abc123k9 --api-key mcps_xxx
  mcp-connect http://localhost:20123
`);
}

/**
 * Best-effort reachability check against GET /health before committing to
 * the stdio proxy. Not fatal on failure - Claude Desktop's first real
 * request will surface the same error through the normal proxy path - but
 * this makes the common "server isn't up" case fail fast with a clear
 * message instead of silently hanging until Claude Desktop sends `initialize`.
 */
async function checkHealth(baseUrl: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);

  try {
    const response = await fetch(healthEndpoint(baseUrl), { signal: controller.signal });
    if (!response.ok) {
      logger.error(
        `mcp-connect: warning: health check at ${healthEndpoint(baseUrl)} returned HTTP ` +
          `${response.status} - continuing anyway, but the server may not be running correctly.`,
      );
      return;
    }
    logger.info(`mcp-connect: health check ok (${healthEndpoint(baseUrl)})`);
  } catch (error) {
    logger.error(
      `mcp-connect: warning: ${formatTransportError(error, baseUrl)} - continuing anyway; ` +
        'the first real request will fail the same way if the server is actually down.',
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    process.exit(0);
  }

  const config = loadConfig();
  const serverArg = args.serverArg ?? '';
  const apiKey = args.apiKey || getApiKey(serverArg) || process.env.MCPEVERYTHING_API_KEY;
  const platformUrl = normalizePlatformUrl(
    args.platformUrl ||
      process.env.MCPEVERYTHING_PLATFORM_URL ||
      process.env.MCP_HOSTING_DOMAIN ||
      config.platformUrl ||
      config.domain ||
      DEFAULT_PLATFORM_URL,
  );

  // Priority: --url flag > $MCPEVERYTHING_BASE_URL > positional server-id-or-url
  // > config file's "baseUrl" (only as a last resort, e.g. `mcp-connect` with
  // no arguments at all relying entirely on the config file).
  let baseUrl: string;
  try {
    if (args.url) {
      baseUrl = args.url;
    } else if (process.env.MCPEVERYTHING_BASE_URL) {
      baseUrl = process.env.MCPEVERYTHING_BASE_URL;
    } else if (serverArg) {
      baseUrl = resolveServerBaseUrl(serverArg, platformUrl);
    } else if (config.baseUrl) {
      baseUrl = config.baseUrl;
    } else {
      printUsage();
      process.exit(1);
      return;
    }
    baseUrl = baseUrl.replace(/\/+$/, '');
  } catch (error) {
    console.error(`mcp-connect: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
    return;
  }

  const mcpUrl = mcpEndpoint(baseUrl);
  logger.info(`mcp-connect: target server ${mcpUrl}${apiKey ? ' (API key set)' : ' (no API key)'}`);

  // The gateway rejects unauthenticated requests, so this is now a real
  // misconfiguration rather than the no-op it used to be.
  if (!apiKey && !supportsHealthCheck(baseUrl)) {
    logger.error(
      'mcp-connect: warning: no API key set, but the MCP Everything gateway requires one. ' +
        'Set $MCPEVERYTHING_API_KEY or pass --api-key <mcps_...>, or the first request will fail with HTTP 401.',
    );
  }

  // The gateway exposes only /mcp per server; see supportsHealthCheck().
  if (supportsHealthCheck(baseUrl)) {
    await checkHealth(baseUrl);
  }

  const headers: Record<string, string> = {};
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const remote = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers },
  });
  const local = new StdioServerTransport();

  const proxy = new McpProxy(local, remote, logger, baseUrl);

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    await proxy.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  try {
    await proxy.start();
  } catch (error) {
    console.error(
      `mcp-connect: failed to start - ${formatTransportError(error, baseUrl)}`,
    );
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('mcp-connect: fatal error:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

// Export for programmatic use / testing.
export { loadConfig, saveConfig, getConfigPath } from './config';
export { getApiKey } from './auth';
export {
  resolveServerBaseUrl,
  mcpEndpoint,
  healthEndpoint,
  supportsHealthCheck,
  normalizePlatformUrl,
} from './url';
export { formatTransportError } from './errors';
export { McpProxy } from './proxy';
