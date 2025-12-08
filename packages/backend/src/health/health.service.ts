import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import {
  HealthResponse,
  ServiceHealth,
  HealthChecks,
  OverallStatus,
} from './health.types';

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private readonly startTime = Date.now();

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

  /**
   * Check Anthropic API availability by verifying API key is configured
   * Note: We don't make actual API calls to avoid rate limiting and costs
   */
  private async checkAnthropic(): Promise<ServiceHealth> {
    const apiKey = this.configService.get<string>('ANTHROPIC_API_KEY');

    if (!apiKey) {
      return {
        status: 'down',
        message: 'API key not configured',
        lastCheck: new Date().toISOString(),
      };
    }

    // Check if API key looks valid (starts with expected prefix)
    if (!apiKey.startsWith('sk-ant-')) {
      return {
        status: 'degraded',
        message: 'API key format may be invalid',
        lastCheck: new Date().toISOString(),
      };
    }

    return {
      status: 'up',
      message: 'API key configured',
      lastCheck: new Date().toISOString(),
    };
  }

  /**
   * Check GitHub API availability by verifying token is configured
   */
  private async checkGitHub(): Promise<ServiceHealth> {
    const token = this.configService.get<string>('GITHUB_TOKEN');

    if (!token) {
      return {
        status: 'down',
        message: 'GitHub token not configured',
        lastCheck: new Date().toISOString(),
      };
    }

    // GitHub tokens can have various formats (classic PAT, fine-grained, app tokens)
    // Just verify it's not empty and has reasonable length
    if (token.length < 10) {
      return {
        status: 'degraded',
        message: 'GitHub token may be invalid',
        lastCheck: new Date().toISOString(),
      };
    }

    return {
      status: 'up',
      message: 'GitHub token configured',
      lastCheck: new Date().toISOString(),
    };
  }

  /**
   * Check Tavily API availability
   * Tavily is optional, so missing key results in degraded, not down
   */
  private async checkTavily(): Promise<ServiceHealth> {
    const apiKey = this.configService.get<string>('TAVILY_API_KEY');

    if (!apiKey) {
      return {
        status: 'degraded',
        message: 'API key not configured (optional service)',
        lastCheck: new Date().toISOString(),
      };
    }

    // Tavily keys typically start with 'tvly-'
    if (!apiKey.startsWith('tvly-')) {
      return {
        status: 'degraded',
        message: 'API key format may be invalid',
        lastCheck: new Date().toISOString(),
      };
    }

    return {
      status: 'up',
      message: 'API key configured',
      lastCheck: new Date().toISOString(),
    };
  }

  /**
   * Calculate overall system status based on individual service checks
   * - healthy: All critical services up
   * - degraded: Optional services down or any service degraded
   * - unhealthy: Critical services (database) down
   */
  private calculateOverallStatus(checks: HealthChecks): OverallStatus {
    // Database is critical - if down, system is unhealthy
    if (checks.database.status === 'down') {
      return 'unhealthy';
    }

    // Redis is important for caching - if down, system is degraded
    if (checks.redis.status === 'down') {
      return 'degraded';
    }

    // Anthropic is critical for AI functionality
    if (checks.anthropic.status === 'down') {
      return 'unhealthy';
    }

    // GitHub is critical for repository analysis
    if (checks.github.status === 'down') {
      return 'unhealthy';
    }

    // Check for any degraded services
    const hasDegrade = Object.values(checks).some(
      (check) => check.status === 'degraded',
    );
    if (hasDegrade) {
      return 'degraded';
    }

    return 'healthy';
  }
}
