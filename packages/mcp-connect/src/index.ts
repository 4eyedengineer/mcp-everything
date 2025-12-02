import { loadConfig } from './config';
import { getApiKey } from './auth';
import { StdioTransport, JsonRpcRequest, JsonRpcResponse } from './transport';
import * as readline from 'readline';

const DEFAULT_BASE_URL = 'https://mcp.mcpeverything.com';

function createErrorResponse(message: string, id: string | number | null = null): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    error: {
      code: -32000,
      message,
    },
    id,
  };
}

function printUsage(): void {
  console.error(`
Usage: mcp-connect <server-id>

Connect Claude Desktop to a cloud-hosted MCP server.

Arguments:
  server-id    The ID of the MCP server to connect to

Environment Variables:
  MCPEVERYTHING_API_KEY    API key for authentication

Config File:
  ~/.mcpeverything/config.json
  {
    "baseUrl": "https://mcp.mcpeverything.com",
    "apiKeys": {
      "default": "your-default-api-key",
      "server-id": "server-specific-key"
    }
  }

Examples:
  # Connect to a server
  mcp-connect stripe-abc123

  # With API key
  MCPEVERYTHING_API_KEY=sk-xxx mcp-connect stripe-abc123
`);
}

async function main(): Promise<void> {
  const serverId = process.argv[2];

  if (!serverId) {
    printUsage();
    process.exit(1);
  }

  if (serverId === '--help' || serverId === '-h') {
    printUsage();
    process.exit(0);
  }

  const config = loadConfig();
  const apiKey = getApiKey(serverId);

  const baseUrl = config.baseUrl || DEFAULT_BASE_URL;
  const serverUrl = `${baseUrl}/${serverId}`;

  const transport = new StdioTransport(serverUrl, apiKey);

  // Set up readline for line-by-line input processing
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  rl.on('line', async (line: string) => {
    if (!line.trim()) {
      return;
    }

    let request: JsonRpcRequest;
    let requestId: string | number | null = null;

    try {
      request = JSON.parse(line) as JsonRpcRequest;
      requestId = request.id;
    } catch (parseError) {
      const errorResponse = createErrorResponse('Invalid JSON', null);
      process.stdout.write(JSON.stringify(errorResponse) + '\n');
      return;
    }

    try {
      const response = await transport.send(request);
      process.stdout.write(JSON.stringify(response) + '\n');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      const errorResponse = createErrorResponse(message, requestId);
      process.stdout.write(JSON.stringify(errorResponse) + '\n');
    }
  });

  rl.on('close', () => {
    transport.close();
    process.exit(0);
  });

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    transport.close();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    transport.close();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('Fatal error:', error.message || error);
  process.exit(1);
});

// Export for programmatic use
export { loadConfig, saveConfig, getConfigPath } from './config';
export { getApiKey } from './auth';
export { StdioTransport, JsonRpcRequest, JsonRpcResponse } from './transport';
