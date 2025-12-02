import express, { Express, Request, Response, NextFunction } from 'express';
import { createServer, Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { MCPBridge, MCPRequest, MCPResponse } from './mcp-bridge';
import { healthHandler, livenessHandler, readinessHandler, configureHealth } from './health';
import {
  metricsHandler,
  trackRequest,
  trackRequestDuration,
  trackError,
  incrementActiveConnections,
  decrementActiveConnections,
  trackBridgeRestart,
} from './metrics';

export interface ServerConfig {
  port: number;
  mcpCommand: string;
  mcpArgs: string[];
  requestTimeout?: number;
}

export interface MCPServer {
  app: Express;
  httpServer: HttpServer;
  wss: WebSocketServer;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

export function createMCPServer(config: ServerConfig): MCPServer {
  const app = express();
  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer, path: '/mcp/stream' });

  // Middleware
  app.use(express.json());

  // Request logging middleware
  app.use((req: Request, _res: Response, next: NextFunction) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
  });

  // Configure health checks
  configureHealth({
    mcpCommand: config.mcpCommand,
    mcpArgs: config.mcpArgs,
  });

  // Health endpoints (K8s probes)
  app.get('/health', healthHandler);
  app.get('/healthz', livenessHandler);
  app.get('/ready', readinessHandler);

  // Metrics endpoint (Prometheus)
  app.get('/metrics', metricsHandler);

  // Synchronous MCP request endpoint
  app.post('/mcp', async (req: Request, res: Response) => {
    const startTime = Date.now();
    const bridge = new MCPBridge(config.mcpCommand, config.mcpArgs, {
      timeout: config.requestTimeout,
    });

    try {
      const request = req.body as MCPRequest;
      const method = request.method || 'unknown';

      const response = await bridge.sendRequest(request);

      trackRequest(method, 'success');
      trackRequestDuration(method, Date.now() - startTime);

      res.json(response);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      trackRequest(req.body?.method || 'unknown', 'error');
      trackError('request_failed');

      res.status(500).json({
        jsonrpc: '2.0',
        id: req.body?.id || null,
        error: {
          code: -32603,
          message: errorMessage,
        },
      } as MCPResponse);
    } finally {
      bridge.close();
    }
  });

  // WebSocket connection handling
  wss.on('connection', (ws: WebSocket) => {
    console.log('[WebSocket] New connection established');
    incrementActiveConnections();

    const bridge = new MCPBridge(config.mcpCommand, config.mcpArgs, {
      timeout: config.requestTimeout,
    });

    ws.on('message', async (data: Buffer | ArrayBuffer | Buffer[]) => {
      const startTime = Date.now();

      try {
        const message = data.toString();
        const request = JSON.parse(message) as MCPRequest;
        const method = request.method || 'unknown';

        const response = await bridge.sendRequest(request);

        trackRequest(method, 'success');
        trackRequestDuration(method, Date.now() - startTime);

        ws.send(JSON.stringify(response));
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';

        trackRequest('unknown', 'error');
        trackError('websocket_error');

        const errorResponse: MCPResponse = {
          jsonrpc: '2.0',
          id: 'error',
          error: {
            code: -32603,
            message: errorMessage,
          },
        };

        ws.send(JSON.stringify(errorResponse));
      }
    });

    ws.on('close', () => {
      console.log('[WebSocket] Connection closed');
      decrementActiveConnections();
      bridge.close();
    });

    ws.on('error', (error: Error) => {
      console.error('[WebSocket] Error:', error.message);
      trackError('websocket_connection_error');
      bridge.close();
    });

    // Handle bridge restarts if needed
    const checkBridge = setInterval(() => {
      if (!bridge.isRunning()) {
        console.log('[WebSocket] Bridge not running, connection will be closed');
        trackBridgeRestart();
        ws.close(1011, 'MCP bridge terminated');
        clearInterval(checkBridge);
      }
    }, 5000);

    ws.on('close', () => clearInterval(checkBridge));
  });

  // Error handling middleware
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[Server Error]', err.message);
    trackError('server_error');
    res.status(500).json({ error: 'Internal server error' });
  });

  const start = (): Promise<void> => {
    return new Promise((resolve) => {
      httpServer.listen(config.port, () => {
        console.log(`[MCP Wrapper] Server listening on port ${config.port}`);
        console.log(`[MCP Wrapper] MCP Command: ${config.mcpCommand} ${config.mcpArgs.join(' ')}`);
        console.log(`[MCP Wrapper] Endpoints:`);
        console.log(`  - POST /mcp         - Synchronous MCP requests`);
        console.log(`  - WS   /mcp/stream  - WebSocket streaming`);
        console.log(`  - GET  /health      - Health check`);
        console.log(`  - GET  /healthz     - Liveness probe`);
        console.log(`  - GET  /ready       - Readiness probe`);
        console.log(`  - GET  /metrics     - Prometheus metrics`);
        resolve();
      });
    });
  };

  const stop = (): Promise<void> => {
    return new Promise((resolve, reject) => {
      console.log('[MCP Wrapper] Shutting down...');

      // Close all WebSocket connections
      wss.clients.forEach((client) => {
        client.close(1001, 'Server shutting down');
      });

      wss.close((err) => {
        if (err) {
          console.error('[MCP Wrapper] Error closing WebSocket server:', err);
        }

        httpServer.close((err) => {
          if (err) {
            console.error('[MCP Wrapper] Error closing HTTP server:', err);
            reject(err);
          } else {
            console.log('[MCP Wrapper] Server stopped');
            resolve();
          }
        });
      });
    });
  };

  return { app, httpServer, wss, start, stop };
}
