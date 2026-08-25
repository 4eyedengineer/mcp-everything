/// <reference types="jest" />
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { UsageStatsService } from './usage-stats.service';
import { Conversation } from '../database/entities/conversation.entity';
import { Deployment } from '../database/entities/deployment.entity';
import { PipelineRun } from '../database/entities/pipeline-run.entity';
import { UsageRecord } from '../database/entities/usage.entity';
import { UserService } from '../user/user.service';

describe('UsageStatsService', () => {
  let service: UsageStatsService;
  let mockConversationRepository: any;
  let mockDeploymentRepository: any;
  let mockPipelineRunRepository: any;
  let mockUsageRecordRepository: any;
  let mockUserService: any;

  const userId = 'user-123';

  const makeQueryBuilder = (runs: Partial<PipelineRun>[]) => ({
    where: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(runs),
  });

  beforeEach(async () => {
    mockConversationRepository = {
      find: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    };

    mockDeploymentRepository = {
      count: jest.fn().mockResolvedValue(0),
    };

    mockPipelineRunRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(makeQueryBuilder([])),
    };

    mockUsageRecordRepository = {
      find: jest.fn().mockResolvedValue([]),
    };

    mockUserService = {
      getUsageStats: jest.fn().mockResolvedValue({
        serversDeployedThisMonth: 0,
        generationsThisMonth: 0,
        monthlyLimit: 5,
        periodStart: new Date('2026-07-01T00:00:00.000Z'),
        periodEnd: new Date('2026-07-31T23:59:59.999Z'),
        percentUsed: 0,
        remainingDeployments: 5,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsageStatsService,
        { provide: getRepositoryToken(Conversation), useValue: mockConversationRepository },
        { provide: getRepositoryToken(Deployment), useValue: mockDeploymentRepository },
        { provide: getRepositoryToken(PipelineRun), useValue: mockPipelineRunRepository },
        { provide: getRepositoryToken(UsageRecord), useValue: mockUsageRecordRepository },
        { provide: UserService, useValue: mockUserService },
      ],
    }).compile();

    service = module.get<UsageStatsService>(UsageStatsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('new user with zero history', () => {
    it('returns a fully-shaped payload with zeroed/null fields instead of erroring', async () => {
      const stats = await service.getStats(userId);

      expect(stats.currentPeriod).toEqual({
        generations: 0,
        limit: 5,
        percentUsed: 0,
        periodEnd: '2026-07-31T23:59:59.999Z',
      });
      expect(stats.totals).toEqual({ generations: 0, conversations: 0, deployments: 0 });
      expect(stats.monthly).toHaveLength(6);
      expect(stats.monthly.every((point) => point.generations === 0)).toBe(true);
      expect(stats.pipeline).toEqual({ successRate: null, avgDurationSeconds: null, totalRuns: 0 });
    });

    it('does not query pipeline_runs when the user has no conversations', async () => {
      await service.getStats(userId);
      expect(mockPipelineRunRepository.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('totals', () => {
    it('sums serversDeployedThisMonth across every historical usage_records row', async () => {
      mockUsageRecordRepository.find.mockResolvedValue([
        { periodStart: new Date('2026-05-01T00:00:00.000Z'), serversDeployedThisMonth: 3 },
        { periodStart: new Date('2026-06-01T00:00:00.000Z'), serversDeployedThisMonth: 2 },
        { periodStart: new Date('2026-07-01T00:00:00.000Z'), serversDeployedThisMonth: 1 },
      ]);
      mockConversationRepository.count.mockResolvedValue(10);
      mockDeploymentRepository.count.mockResolvedValue(4);

      const stats = await service.getStats(userId);

      expect(stats.totals).toEqual({ generations: 6, conversations: 10, deployments: 4 });
    });

    it('scopes conversation/deployment counts to the current user', async () => {
      await service.getStats(userId);

      expect(mockConversationRepository.count).toHaveBeenCalledWith({ where: { userId } });
      expect(mockDeploymentRepository.count).toHaveBeenCalledWith({ where: { userId } });
    });
  });

  describe('monthly trend', () => {
    it('buckets historical usage_records by calendar month, summing same-month rows (mid-month resets)', async () => {
      // Mirrors UserService.createUsageRecord, which builds periodStart from
      // local Date components (`new Date(now.getFullYear(), now.getMonth(), 1)`),
      // not a UTC ISO string - constructing it the same way here so the test
      // is timezone-independent.
      const now = new Date();
      const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const thisMonthKey = `${thisMonthStart.getFullYear()}-${String(thisMonthStart.getMonth() + 1).padStart(2, '0')}`;

      mockUsageRecordRepository.find.mockResolvedValue([
        // Two rows in the same month can happen if a Stripe payment resets
        // usage mid-period; both counts genuinely happened that month.
        { periodStart: thisMonthStart, serversDeployedThisMonth: 2 },
        { periodStart: thisMonthStart, serversDeployedThisMonth: 3 },
      ]);

      const stats = await service.getStats(userId);
      const currentMonthPoint = stats.monthly.find((p) => p.month === thisMonthKey);

      expect(currentMonthPoint?.generations).toBe(5);
    });

    it('returns exactly 6 months, oldest first, regardless of data present', async () => {
      const stats = await service.getStats(userId);
      expect(stats.monthly).toHaveLength(6);
      for (let i = 1; i < stats.monthly.length; i++) {
        expect(stats.monthly[i].month >= stats.monthly[i - 1].month).toBe(true);
      }
    });
  });

  describe('pipeline stats', () => {
    beforeEach(() => {
      mockConversationRepository.find.mockResolvedValue([{ id: 'conv-1' }, { id: 'conv-2' }]);
    });

    it('computes success rate and avg duration across finished, per-conversation runs', async () => {
      mockPipelineRunRepository.createQueryBuilder.mockReturnValue(
        makeQueryBuilder([
          { conversationId: 'conv-1', status: 'succeeded', durationMs: 1000 },
          { conversationId: 'conv-1', status: 'succeeded', durationMs: 2000 },
          { conversationId: 'conv-2', status: 'failed', durationMs: 500 },
        ]),
      );

      const stats = await service.getStats(userId);

      expect(stats.pipeline.totalRuns).toBe(2);
      expect(stats.pipeline.successRate).toBe(50); // 1 of 2 conversations had zero failed steps
      // (1000+2000)/1000 = 3s for conv-1, 500/1000 = 0.5s for conv-2 -> avg 1.75s -> rounds to 2
      expect(stats.pipeline.avgDurationSeconds).toBe(2);
    });

    it('excludes runs where every step is still running from both success rate and totals', async () => {
      mockPipelineRunRepository.createQueryBuilder.mockReturnValue(
        makeQueryBuilder([{ conversationId: 'conv-1', status: 'running', durationMs: null }]),
      );

      const stats = await service.getStats(userId);

      expect(stats.pipeline).toEqual({ successRate: null, avgDurationSeconds: null, totalRuns: 0 });
    });

    it('treats a conversation as successful only when none of its steps failed', async () => {
      mockPipelineRunRepository.createQueryBuilder.mockReturnValue(
        makeQueryBuilder([
          { conversationId: 'conv-1', status: 'succeeded', durationMs: 100 },
          { conversationId: 'conv-1', status: 'failed', durationMs: 50 },
        ]),
      );

      const stats = await service.getStats(userId);

      expect(stats.pipeline.totalRuns).toBe(1);
      expect(stats.pipeline.successRate).toBe(0);
    });
  });
});
