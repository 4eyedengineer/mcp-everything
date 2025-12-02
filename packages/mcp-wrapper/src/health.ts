import { Request, Response } from 'express';

export interface HealthStatus {
  status: 'healthy' | 'unhealthy';
  uptime: number;
  timestamp: string;
  mcpServer?: {
    running: boolean;
    command: string;
  };
}

export interface HealthCheckOptions {
  mcpCommand: string;
  mcpArgs: string[];
  checkMcpRunning?: () => boolean;
}

let healthOptions: HealthCheckOptions = {
  mcpCommand: 'node',
  mcpArgs: ['dist/index.js'],
};

export function configureHealth(options: HealthCheckOptions): void {
  healthOptions = options;
}

export function healthHandler(_req: Request, res: Response): void {
  const health: HealthStatus = {
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    mcpServer: {
      running: healthOptions.checkMcpRunning?.() ?? true,
      command: `${healthOptions.mcpCommand} ${healthOptions.mcpArgs.join(' ')}`,
    },
  };

  if (healthOptions.checkMcpRunning && !healthOptions.checkMcpRunning()) {
    health.status = 'unhealthy';
    res.status(503).json(health);
    return;
  }

  res.json(health);
}

export function livenessHandler(_req: Request, res: Response): void {
  res.json({
    status: 'alive',
    timestamp: new Date().toISOString(),
  });
}

export function readinessHandler(_req: Request, res: Response): void {
  const isReady = healthOptions.checkMcpRunning?.() ?? true;

  if (isReady) {
    res.json({
      status: 'ready',
      timestamp: new Date().toISOString(),
    });
  } else {
    res.status(503).json({
      status: 'not_ready',
      timestamp: new Date().toISOString(),
    });
  }
}
