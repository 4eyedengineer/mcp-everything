#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { loadConfig } from './config';
import { getApiKey } from './auth';
import { resolveServerBaseUrl, mcpEndpoint, healthEndpoint, DEFAULT_DOMAIN } from './url';
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
  domain?: string;
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
      case '--domain':
        args.domain = argv[++i];
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

    Claude Desktop  <--stdio-->  mcp-connect (this)  <--HTTPS-->  hosted server

Arguments:
  server-id-or-url   Either:
                       - a full base URL, e.g.
                         https://my-server.mcp.example.com, or
                         http://localhost:8080 (local docker-run hosting)
                       - a bare server ID, e.g. stripe-abc123k9, expanded to
                         https://<server-id>.<domain>

Options:
  --url <url>        Same as passing a full URL positionally. Takes priority
                      over the positional argument and $MCPEVERYTHING_BASE_URL.
  --domain <domain>  Domain suffix used when the argument is a bare server ID.
                      Default: $MCP_HOSTING_DOMAIN, then "${DEFAULT_DOMAIN}".
  --api-key <key>    Bearer token forwarded as "Authorization: Bearer <key>".
                      Hosted servers do not enforce any auth scheme today, so
                      omitting this (and $MCPEVERYTHING_API_KEY) is a no-op -
                      nothing pretends to check it.
  -h, --help         Show this help.

Environment Variables:
  MCPEVERYTHING_API_KEY     API key for authentication (same as --api-key)
  MCPEVERYTHING_BASE_URL    Full base URL; overrides the positional argument
  MCP_HOSTING_DOMAIN        Domain suffix for bare server IDs (see --domain)

Config File (~/.mcpeverything/config.json or ~/.config/mcpeverything/config.json):
  {
    "baseUrl": "https://my-server.mcp.example.com",
    "domain": "mcp.example.com",
    "apiKeys": {
      "default": "your-default-api-key",
      "server-id": "server-specific-key"
    }
  }

Examples:
  mcp-connect stripe-abc123k9
  mcp-connect https://stripe-abc123k9.mcp.example.com
  mcp-connect http://localhost:8080
  MCPEVERYTHING_API_KEY=sk-xxx mcp-connect stripe-abc123k9
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
  const domain = args.domain || process.env.MCP_HOSTING_DOMAIN || config.domain || DEFAULT_DOMAIN;

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
      baseUrl = resolveServerBaseUrl(serverArg, domain);
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

  await checkHealth(baseUrl);

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
export { resolveServerBaseUrl, mcpEndpoint, healthEndpoint } from './url';
export { formatTransportError } from './errors';
export { McpProxy } from './proxy';
