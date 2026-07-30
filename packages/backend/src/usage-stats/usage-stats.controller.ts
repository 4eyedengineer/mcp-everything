import { Controller, Get } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../database/entities/user.entity';
import { UsageStatsResponse, UsageStatsService } from './usage-stats.service';

// Route protected by the global JWT guard - user is authenticated automatically.
@Controller('api/v1/usage-stats')
export class UsageStatsController {
  constructor(private readonly usageStatsService: UsageStatsService) {}

  @Get()
  async getUsageStats(@CurrentUser() user: User): Promise<UsageStatsResponse> {
    return this.usageStatsService.getStats(user.id);
  }
}
