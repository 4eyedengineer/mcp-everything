import { Controller, Get, Res } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Response } from 'express';
import { SkipThrottle } from '@nestjs/throttler';
import { MetricsService } from './metrics.service';
import { Public } from '../auth/decorators/public.decorator';

@ApiTags('metrics')
@Controller('metrics')
@Public() // Prometheus cannot send a JWT; restrict at the network layer instead
@SkipThrottle() // Prometheus scrapes on a fixed interval; do not rate limit
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  @Get()
  @ApiOperation({ summary: 'Get Prometheus metrics' })
  @ApiResponse({
    status: 200,
    description: 'Returns metrics in Prometheus text format',
  })
  async getMetrics(@Res() res: Response): Promise<void> {
    const metrics = await this.metricsService.getMetrics();
    const contentType = await this.metricsService.getContentType();

    res.set('Content-Type', contentType);
    res.send(metrics);
  }
}
