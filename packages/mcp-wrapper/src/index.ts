import { createMCPServer, ServerConfig, MCPServer } from './server';

// Export for programmatic usage
export { createMCPServer, ServerConfig, MCPServer };
export { MCPBridge, MCPRequest, MCPResponse } from './mcp-bridge';
export { healthHandler, livenessHandler, readinessHandler, configureHealth } from './health';
export * from './metrics';

// Main entry point when run directly
async function main(): Promise<void> {
  const config: ServerConfig = {
    port: parseInt(process.env.PORT || '3000', 10),
    mcpCommand: process.env.MCP_COMMAND || 'node',
    mcpArgs: (process.env.MCP_ARGS || 'dist/index.js').split(' '),
    requestTimeout: parseInt(process.env.MCP_REQUEST_TIMEOUT || '30000', 10),
  };

  console.log('[MCP Wrapper] Starting with configuration:');
  console.log(`  PORT: ${config.port}`);
  console.log(`  MCP_COMMAND: ${config.mcpCommand}`);
  console.log(`  MCP_ARGS: ${config.mcpArgs.join(' ')}`);
  console.log(`  MCP_REQUEST_TIMEOUT: ${config.requestTimeout}ms`);

  const server = createMCPServer(config);

  // Graceful shutdown handlers
  let isShuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (isShuttingDown) {
      console.log('[MCP Wrapper] Shutdown already in progress...');
      return;
    }

    isShuttingDown = true;
    console.log(`[MCP Wrapper] Received ${signal}, initiating graceful shutdown...`);

    try {
      await server.stop();
      console.log('[MCP Wrapper] Graceful shutdown complete');
      process.exit(0);
    } catch (error) {
      console.error('[MCP Wrapper] Error during shutdown:', error);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle uncaught errors
  process.on('uncaughtException', (error: Error) => {
    console.error('[MCP Wrapper] Uncaught exception:', error);
    shutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason: unknown) => {
    console.error('[MCP Wrapper] Unhandled rejection:', reason);
  });

  // Start the server
  try {
    await server.start();
  } catch (error) {
    console.error('[MCP Wrapper] Failed to start server:', error);
    process.exit(1);
  }
}

// Run main if this file is executed directly
if (require.main === module) {
  main();
}
