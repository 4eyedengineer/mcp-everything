/**
 * Health check types for comprehensive service status reporting
 */

export type ServiceStatus = 'up' | 'down' | 'degraded';
export type OverallStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface ServiceHealth {
  status: ServiceStatus;
  latency?: number;
  message?: string;
  lastCheck: string;
}

export interface HealthChecks {
  database: ServiceHealth;
  redis: ServiceHealth;
  anthropic: ServiceHealth;
  github: ServiceHealth;
  tavily: ServiceHealth;
}

export interface HealthResponse {
  status: OverallStatus;
  timestamp: string;
  version: string;
  uptime: number;
  checks: HealthChecks;
}

export interface ReadinessResponse {
  ready: boolean;
}

export interface LivenessResponse {
  alive: boolean;
}
