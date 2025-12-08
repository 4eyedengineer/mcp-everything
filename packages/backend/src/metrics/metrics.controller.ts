import { Controller, Get, Header, Res } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Response } from 'express';
import { MetricsService } from './metrics.service';

@ApiTags('metrics')
@Controller('metrics')
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
