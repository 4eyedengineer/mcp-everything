import { Request, Response } from 'express';
import {
  Registry,
  Counter,
  Histogram,
  Gauge,
  collectDefaultMetrics,
} from 'prom-client';

// Create a custom registry
export const registry = new Registry();

// Collect default Node.js metrics
collectDefaultMetrics({ register: registry });

// Custom MCP metrics
export const mcpRequestsTotal = new Counter({
  name: 'mcp_requests_total',
  help: 'Total number of MCP requests',
  labelNames: ['method', 'status'],
  registers: [registry],
});

export const mcpRequestDuration = new Histogram({
  name: 'mcp_request_duration_seconds',
  help: 'Duration of MCP requests in seconds',
  labelNames: ['method'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [registry],
});

export const mcpActiveConnections = new Gauge({
  name: 'mcp_active_connections',
  help: 'Number of active WebSocket connections',
  registers: [registry],
});

export const mcpErrorsTotal = new Counter({
  name: 'mcp_errors_total',
  help: 'Total number of MCP errors',
  labelNames: ['type'],
  registers: [registry],
});

export const mcpBridgeRestarts = new Counter({
  name: 'mcp_bridge_restarts_total',
  help: 'Total number of MCP bridge restarts',
  registers: [registry],
});

// Metrics endpoint handler
export async function metricsHandler(_req: Request, res: Response): Promise<void> {
  try {
    res.set('Content-Type', registry.contentType);
    res.end(await registry.metrics());
  } catch (error) {
    res.status(500).end();
  }
}

// Helper functions for tracking metrics
export function trackRequest(method: string, status: 'success' | 'error'): void {
  mcpRequestsTotal.inc({ method, status });
}

export function trackRequestDuration(method: string, durationMs: number): void {
  mcpRequestDuration.observe({ method }, durationMs / 1000);
}

export function incrementActiveConnections(): void {
  mcpActiveConnections.inc();
}

export function decrementActiveConnections(): void {
  mcpActiveConnections.dec();
}

export function trackError(type: string): void {
  mcpErrorsTotal.inc({ type });
}

export function trackBridgeRestart(): void {
  mcpBridgeRestarts.inc();
}
