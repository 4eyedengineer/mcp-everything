import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Conversation } from '../database/entities/conversation.entity';
import { Deployment } from '../database/entities/deployment.entity';
import { PipelineRun } from '../database/entities/pipeline-run.entity';
import { UsageRecord } from '../database/entities/usage.entity';
import { UserService } from '../user/user.service';

export interface UsageStatsCurrentPeriod {
  generations: number;
  limit: number;
  percentUsed: number;
  periodEnd: string;
}

export interface UsageStatsTotals {
  generations: number;
  conversations: number;
  deployments: number;
}

export interface UsageStatsMonthlyPoint {
  /** 'YYYY-MM', oldest first. */
  month: string;
  generations: number;
}

export interface UsageStatsPipeline {
  /** 0-100, or null when there are no completed pipeline runs yet. */
  successRate: number | null;
  avgDurationSeconds: number | null;
  /** Number of pipeline runs (conversations with at least one finished step) considered. */
  totalRuns: number;
}

export interface UsageStatsResponse {
  currentPeriod: UsageStatsCurrentPeriod;
  totals: UsageStatsTotals;
  monthly: UsageStatsMonthlyPoint[];
  pipeline: UsageStatsPipeline;
}

const MONTHLY_TREND_MONTHS = 6;

/**
 * Read-only aggregation service for the account page "Usage Statistics"
 * panel. Every field here is derived from data the rest of the platform
 * already writes for other purposes (quota enforcement, pipeline
 * observability, conversation/deployment bookkeeping) - nothing is
 * fabricated, and fields with no real backing data (e.g. token totals -
 * `PipelineRun` does not persist token counts) are simply omitted rather
 * than faked.
 */
@Injectable()
export class UsageStatsService {
  constructor(
    @InjectRepository(Conversation)
    private readonly conversationRepository: Repository<Conversation>,
    @InjectRepository(Deployment)
    private readonly deploymentRepository: Repository<Deployment>,
    @InjectRepository(PipelineRun)
    private readonly pipelineRunRepository: Repository<PipelineRun>,
    @InjectRepository(UsageRecord)
    private readonly usageRecordRepository: Repository<UsageRecord>,
    private readonly userService: UserService,
  ) {}

  async getStats(userId: string): Promise<UsageStatsResponse> {
    const [currentPeriod, totals, monthly, pipeline] = await Promise.all([
      this.getCurrentPeriod(userId),
      this.getTotals(userId),
      this.getMonthlyTrend(userId),
      this.getPipelineStats(userId),
    ]);

    return { currentPeriod, totals, monthly, pipeline };
  }

  /** Current billing-period quota usage - reuses the same logic that powers the subscription tier gate. */
  private async getCurrentPeriod(userId: string): Promise<UsageStatsCurrentPeriod> {
    const usage = await this.userService.getUsageStats(userId);
    return {
      generations: usage.generationsThisMonth,
      limit: usage.monthlyLimit,
      percentUsed: usage.percentUsed,
      periodEnd: usage.periodEnd.toISOString(),
    };
  }

  private async getTotals(userId: string): Promise<UsageStatsTotals> {
    const [usageRecords, conversations, deployments] = await Promise.all([
      this.usageRecordRepository.find({ where: { userId } }),
      this.conversationRepository.count({ where: { userId } }),
      this.deploymentRepository.count({ where: { userId } }),
    ]);

    // Each usage_records row is frozen at the count it reached before the
    // next monthly (or reset-triggered) rollover, so summing every row for
    // the user is a full lifetime total, not a per-period double-count -
    // see UserService.createUsageRecord: a new row always starts back at 0.
    const generations = usageRecords.reduce(
      (sum, record) => sum + record.serversDeployedThisMonth,
      0,
    );

    return { generations, conversations, deployments };
  }

  /** Last N months of generation counts, derived from historical usage_records rows. */
  private async getMonthlyTrend(userId: string): Promise<UsageStatsMonthlyPoint[]> {
    const records = await this.usageRecordRepository.find({ where: { userId } });

    const byMonth = new Map<string, number>();
    for (const record of records) {
      const key = this.monthKey(record.periodStart);
      byMonth.set(key, (byMonth.get(key) || 0) + record.serversDeployedThisMonth);
    }

    const now = new Date();
    const points: UsageStatsMonthlyPoint[] = [];
    for (let i = MONTHLY_TREND_MONTHS - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = this.monthKey(d);
      points.push({ month: key, generations: byMonth.get(key) || 0 });
    }

    return points;
  }

  /**
   * Pipeline health for this user's generation attempts, derived from
   * `pipeline_runs`. A "run" is one conversation's set of step rows; it
   * counts as successful when none of its steps recorded `failed` (the
   * failing step is closed with status 'failed' before the outer
   * `handleError` side-path step runs and itself succeeds, so scoping by
   * conversation - not by row - avoids the helper steps skewing the rate).
   * Runs that are still in flight (every row `running`) are excluded from
   * both the numerator and denominator.
   */
  private async getPipelineStats(userId: string): Promise<UsageStatsPipeline> {
    const conversations = await this.conversationRepository.find({
      where: { userId },
      select: ['id'],
    });

    if (conversations.length === 0) {
      return { successRate: null, avgDurationSeconds: null, totalRuns: 0 };
    }

    const conversationIds = conversations.map((c) => c.id);
    const runs = await this.pipelineRunRepository
      .createQueryBuilder('run')
      .where('run.conversationId IN (:...conversationIds)', { conversationIds })
      .getMany();

    const byConversation = new Map<string, PipelineRun[]>();
    for (const run of runs) {
      const list = byConversation.get(run.conversationId) || [];
      list.push(run);
      byConversation.set(run.conversationId, list);
    }

    let finishedRuns = 0;
    let successfulRuns = 0;
    let totalDurationMs = 0;
    let durationSamples = 0;

    for (const steps of byConversation.values()) {
      const isFinished = steps.some((s) => s.status !== 'running');
      if (!isFinished) {
        continue;
      }

      finishedRuns++;
      const hasFailure = steps.some((s) => s.status === 'failed');
      if (!hasFailure) {
        successfulRuns++;
      }

      const runDurationMs = steps
        .filter((s) => typeof s.durationMs === 'number')
        .reduce((sum, s) => sum + (s.durationMs as number), 0);
      if (runDurationMs > 0) {
        totalDurationMs += runDurationMs;
        durationSamples++;
      }
    }

    return {
      successRate: finishedRuns > 0 ? Math.round((successfulRuns / finishedRuns) * 100) : null,
      avgDurationSeconds:
        durationSamples > 0 ? Math.round(totalDurationMs / durationSamples / 1000) : null,
      totalRuns: finishedRuns,
    };
  }

  private monthKey(date: Date): string {
    const d = new Date(date);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
}
