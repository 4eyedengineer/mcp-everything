import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  ServiceUnavailableException,
} from '@nestjs/common';
import { HealthService } from './health.service';
import {
  HealthResponse,
  ReadinessResponse,
  LivenessResponse,
} from './health.types';

@Controller('api/v1/health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  /**
   * GET /api/v1/health
   * Returns comprehensive health status of all services
   */
  @Get()
  @HttpCode(HttpStatus.OK)
  async getHealth(): Promise<HealthResponse> {
    return this.healthService.checkAll();
  }

  /**
   * GET /api/v1/health/ready
   * Kubernetes readiness probe endpoint
   * Returns 200 if service is ready to accept traffic, 503 otherwise
   */
  @Get('ready')
  async getReadiness(): Promise<ReadinessResponse> {
    const health = await this.healthService.checkAll();

    if (health.status === 'unhealthy') {
      throw new ServiceUnavailableException('Service not ready');
    }

    return { ready: true };
  }

  /**
   * GET /api/v1/health/live
   * Kubernetes liveness probe endpoint
   * Returns 200 if service is alive (always returns true if endpoint is reachable)
   */
  @Get('live')
  @HttpCode(HttpStatus.OK)
  getLiveness(): LivenessResponse {
    return { alive: true };
  }
}
