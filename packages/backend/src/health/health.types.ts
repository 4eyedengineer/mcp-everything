/**
 * Health check types for comprehensive service status reporting
 */

/**
 * Per-service status.
 *
 * The distinction between `up` and `configured` is deliberate and load-bearing:
 *
 * - `up`            - a real call was made to the dependency and it answered.
 * - `configured`    - credentials are present and well-formed, but nothing was
 *                     verified. Used only where there is no cheap probe to make
 *                     (Anthropic has no free ping endpoint). Reporting these as
 *                     `up` is how health checks come to claim a service is
 *                     working while the logs fill with auth failures.
 * - `not_configured`- no credentials supplied at all.
 * - `degraded`      - reachable/present but impaired (throttled, odd key shape).
 * - `down`          - a real call was made and failed.
 */
export type ServiceStatus = 'up' | 'down' | 'degraded' | 'configured' | 'not_configured';
export type OverallStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface ServiceHealth {
  status: ServiceStatus;
  latency?: number;
  message?: string;
  lastCheck: string;
  /**
   * True when `status` reflects an actual call to the dependency, false when it
   * only reflects configuration. Lets a dashboard tell "verified working" from
   * "we assume so".
   */
  verified?: boolean;
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
