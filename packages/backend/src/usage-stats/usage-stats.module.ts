import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Conversation, Deployment, PipelineRun, UsageRecord } from '../database/entities';
import { UserModule } from '../user/user.module';
import { UsageStatsController } from './usage-stats.controller';
import { UsageStatsService } from './usage-stats.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Conversation, Deployment, PipelineRun, UsageRecord]),
    // UserService.getUsageStats() powers the current-period figures so this
    // module never re-derives quota math independently of the tier gate.
    UserModule,
  ],
  controllers: [UsageStatsController],
  providers: [UsageStatsService],
  exports: [UsageStatsService],
})
export class UsageStatsModule {}
