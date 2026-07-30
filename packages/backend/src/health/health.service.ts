import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Octokit } from '@octokit/rest';
import { HealthResponse, ServiceHealth, HealthChecks, OverallStatus } from './health.types';

/** How long a live third-party probe result is reused for. */
const PROBE_CACHE_TTL_MS = 60_000;

/** Ceiling on a live probe so /health stays fast enough for a k8s probe. */
const PROBE_TIMEOUT_MS = 3_000;

/** Values people leave in .env.example that are not real credentials. */
const PLACEHOLDER_SECRETS = new Set([
  'your-github-token-here',
  'your-api-key-here',
  'changeme',
  'todo',
]);

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private readonly startTime = Date.now();

  /** Cached GitHub probe result - the only check that leaves the process. */
  private githubProbe?: { at: number; result: ServiceHealth };

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Perform all health checks and return comprehensive status
   */
  async checkAll(): Promise<HealthResponse> {
    const [database, redis, anthropic, github, tavily] = await Promise.all([
      this.checkDatabase(),
      this.checkRedis(),
      this.checkAnthropic(),
      this.checkGitHub(),
      this.checkTavily(),
    ]);

    const checks: HealthChecks = { database, redis, anthropic, github, tavily };
    const status = this.calculateOverallStatus(checks);

    return {
      status,
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version || '0.0.0',
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      checks,
    };
  }

  /**
   * Check database connectivity by running a simple query
   */
  private async checkDatabase(): Promise<ServiceHealth> {
    const start = Date.now();
    try {
      await this.dataSource.query('SELECT 1');
      return {
        status: 'up',
        latency: Date.now() - start,
        lastCheck: new Date().toISOString(),
      };
    } catch (error) {
      this.logger.error(`Database health check failed: ${error.message}`);
      return {
        status: 'down',
        message: error.message,
        lastCheck: new Date().toISOString(),
      };
    }
  }

  /**
   * Check Redis connectivity by sending PING command
   */
  private async checkRedis(): Promise<ServiceHealth> {
    const start = Date.now();
    const redisHost = this.configService.get<string>('REDIS_HOST', 'localhost');
    const redisPort = this.configService.get<number>('REDIS_PORT', 6379);

    try {
      // Use native net module for a lightweight connection test
      const net = await import('net');

      const isConnected = await new Promise<boolean>((resolve) => {
        const client = new net.Socket();
        const timeout = setTimeout(() => {
          client.destroy();
          resolve(false);
        }, 3000);

        client.connect(redisPort, redisHost, () => {
          // Send PING command
          client.write('*1\r\n$4\r\nPING\r\n');
        });

        client.on('data', (data) => {
          clearTimeout(timeout);
          client.destroy();
          // Redis responds with +PONG\r\n
          resolve(data.toString().includes('PONG'));
        });

        client.on('error', () => {
          clearTimeout(timeout);
          client.destroy();
          resolve(false);
        });
      });

      if (isConnected) {
        return {
          status: 'up',
          latency: Date.now() - start,
          lastCheck: new Date().toISOString(),
        };
      } else {
        return {
          status: 'down',
          message: 'Redis connection failed',
          lastCheck: new Date().toISOString(),
        };
      }
    } catch (error) {
      this.logger.error(`Redis health check failed: ${error.message}`);
      return {
        status: 'down',
        message: error.message,
        lastCheck: new Date().toISOString(),
      };
    }
  }

  /** Is this a real secret, or a placeholder / empty value? */
  private isConfigured(secret?: string): boolean {
    const value = secret?.trim();
    return Boolean(value) && !PLACEHOLDER_SECRETS.has(value!.toLowerCase());
  }

  /**
   * Check Anthropic API credentials.
   *
   * Reports `configured`, never `up`: Anthropic has no free health/ping endpoint,
   * so the only way to verify the key is to spend money on a completion, which a
   * probe hit on every k8s interval must not do. The status name says exactly
   * what was established - that a well-formed key is present - rather than
   * claiming a liveness we did not check.
   */
  private async checkAnthropic(): Promise<ServiceHealth> {
    const apiKey = this.configService.get<string>('ANTHROPIC_API_KEY');
    const lastCheck = new Date().toISOString();

    if (!this.isConfigured(apiKey)) {
      return { status: 'not_configured', message: 'API key not configured', lastCheck };
    }

    if (!apiKey!.startsWith('sk-ant-')) {
      return {
        status: 'degraded',
        message:
          'API key present but does not look like an Anthropic key (expected sk-ant- prefix)',
        lastCheck,
        verified: false,
      };
    }

    return {
      status: 'configured',
      message: 'API key present; not verified (no free probe endpoint)',
      lastCheck,
      verified: false,
    };
  }

  /**
   * Check GitHub by actually calling the API with the configured token.
   *
   * Token *presence* is not health. This check previously reported `up` whenever
   * a GITHUB_TOKEN of any kind was set, and went on doing so while every real
   * GitHub call in the process failed with "Bad credentials" - the single most
   * misleading thing a health endpoint can do.
   *
   * `GET /rate_limit` is the right probe: it is authenticated (so it fails on a
   * bad token), free (it does not consume rate limit), and cheap. The result is
   * cached for a minute so k8s probing every few seconds does not turn into
   * per-probe network round trips.
   */
  private async checkGitHub(): Promise<ServiceHealth> {
    const cached = this.githubProbe;
    if (cached && Date.now() - cached.at < PROBE_CACHE_TTL_MS) {
      return cached.result;
    }

    const result = await this.probeGitHub();
    this.githubProbe = { at: Date.now(), result };
    return result;
  }

  private async probeGitHub(): Promise<ServiceHealth> {
    const token = this.configService.get<string>('GITHUB_TOKEN');
    const lastCheck = new Date().toISOString();

    if (!this.isConfigured(token)) {
      return { status: 'not_configured', message: 'GitHub token not configured', lastCheck };
    }

    const start = Date.now();

    try {
      const octokit = new Octokit({ auth: token });
      const response = await this.withTimeout(
        octokit.rest.rateLimit.get(),
        'GitHub rate-limit probe',
      );

      const core = response.data?.resources?.core;
      const latency = Date.now() - start;

      // Authenticated but exhausted: real calls will fail until the window resets.
      if (core && core.remaining === 0) {
        return {
          status: 'degraded',
          message: `authenticated, but core rate limit exhausted (resets ${new Date(
            core.reset * 1000,
          ).toISOString()})`,
          latency,
          lastCheck,
          verified: true,
        };
      }

      return {
        status: 'up',
        message: core
          ? `authenticated (${core.remaining}/${core.limit} core requests remaining)`
          : 'authenticated',
        latency,
        lastCheck,
        verified: true,
      };
    } catch (error) {
      const status = (error as { status?: number }).status;
      const message =
        status === 401
          ? 'bad credentials - the configured GITHUB_TOKEN was rejected'
          : status === 403
            ? `forbidden - ${error.message}`
            : error.message;

      this.logger.warn(`GitHub health probe failed: ${message}`);

      return {
        status: 'down',
        message,
        latency: Date.now() - start,
        lastCheck,
        verified: true,
      };
    }
  }

  /**
   * Check Tavily API credentials.
   *
   * Key-presence only, and named honestly as such. Tavily's search endpoint is
   * metered, so probing it on every k8s interval would bill the user for health
   * checks; there is no free equivalent of GitHub's /rate_limit.
   */
  private async checkTavily(): Promise<ServiceHealth> {
    const apiKey = this.configService.get<string>('TAVILY_API_KEY');
    const lastCheck = new Date().toISOString();

    if (!this.isConfigured(apiKey)) {
      return {
        status: 'not_configured',
        message: 'API key not configured (optional service)',
        lastCheck,
      };
    }

    if (!apiKey!.startsWith('tvly-')) {
      return {
        status: 'degraded',
        message: 'API key present but does not look like a Tavily key (expected tvly- prefix)',
        lastCheck,
        verified: false,
      };
    }

    return {
      status: 'configured',
      message: 'API key present; not verified (search calls are metered)',
      lastCheck,
      verified: false,
    };
  }

  /** Bound a probe so a hanging dependency cannot hang the health endpoint. */
  private async withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;

    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${label} timed out after ${PROBE_TIMEOUT_MS}ms`)),
            PROBE_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  /**
   * Roll the individual checks up into one status.
   *
   * - unhealthy: the service cannot do its job at all - no database, or no
   *   Anthropic credentials (every pipeline step is an LLM call).
   * - degraded: something is impaired but requests can still be served. A
   *   rejected GitHub token lands here rather than in `unhealthy`: it breaks
   *   repository-input research only, and 503-ing the readiness probe over a
   *   stale PAT would take a working deployment out of service. `configured`
   *   (unverified credentials) is not on its own a degradation.
   */
  private calculateOverallStatus(checks: HealthChecks): OverallStatus {
    // Database is critical - nothing works without it.
    if (checks.database.status === 'down' || checks.database.status === 'not_configured') {
      return 'unhealthy';
    }

    // Anthropic is critical: with no key there is no pipeline.
    if (checks.anthropic.status === 'down' || checks.anthropic.status === 'not_configured') {
      return 'unhealthy';
    }

    // Redis is a cache; GitHub only gates repo-input research; Tavily is
    // optional. Any of them failing degrades capability, not availability.
    const degrading: ServiceHealth[] = [checks.redis, checks.github, checks.tavily];
    if (degrading.some((check) => check.status === 'down' || check.status === 'not_configured')) {
      return 'degraded';
    }

    if (Object.values(checks).some((check) => check.status === 'degraded')) {
      return 'degraded';
    }

    return 'healthy';
  }
}
