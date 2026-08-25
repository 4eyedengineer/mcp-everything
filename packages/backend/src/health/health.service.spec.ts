import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getDataSourceToken } from '@nestjs/typeorm';
import { HealthService } from './health.service';

describe('HealthService', () => {
  let dataSource: { query: jest.Mock };
  let config: Record<string, string | undefined>;

  const buildService = async (): Promise<HealthService> => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HealthService,
        { provide: getDataSourceToken(), useValue: dataSource },
        {
          provide: ConfigService,
          useValue: { get: jest.fn((key: string, fallback?: unknown) => config[key] ?? fallback) },
        },
      ],
    }).compile();

    return module.get(HealthService);
  };

  beforeEach(() => {
    dataSource = { query: jest.fn().mockResolvedValue([{ '?column?': 1 }]) };
    config = {
      ANTHROPIC_API_KEY: 'sk-ant-configured-key',
      GITHUB_TOKEN: undefined,
      TAVILY_API_KEY: undefined,
    };
  });

  it('does not probe Redis: checkAll only reports database, anthropic, github, tavily', async () => {
    const service = await buildService();

    const result = await service.checkAll();

    expect(Object.keys(result.checks).sort()).toEqual(['anthropic', 'database', 'github', 'tavily']);
    expect((result.checks as unknown as Record<string, unknown>).redis).toBeUndefined();
  });

  it('reports healthy (not degraded) with database up, Anthropic configured, and GitHub/Tavily healthy, even though Redis is unused', async () => {
    config.GITHUB_TOKEN = 'ghp_sometoken';
    config.TAVILY_API_KEY = 'tvly-configuredkey';
    const service = await buildService();

    // Avoid a real network call: stub the only check that leaves the process.
    jest
      .spyOn(service as unknown as { probeGitHub: () => Promise<unknown> }, 'probeGitHub')
      .mockResolvedValue({
        status: 'up',
        message: 'authenticated',
        lastCheck: new Date().toISOString(),
        verified: true,
      });

    const result = await service.checkAll();

    expect(result.checks.database.status).toBe('up');
    expect(result.checks.anthropic.status).toBe('configured');
    // Before this fix, this scenario reported "degraded" purely because the
    // (now-removed) Redis probe found nothing listening on REDIS_HOST/PORT.
    expect(result.status).toBe('healthy');
  });

  it('is unhealthy when the database is down, independent of any Redis state', async () => {
    dataSource.query.mockRejectedValue(new Error('connection refused'));
    const service = await buildService();

    const result = await service.checkAll();

    expect(result.checks.database.status).toBe('down');
    expect(result.status).toBe('unhealthy');
  });

  it('degrades (not fails outright) when only GitHub is down', async () => {
    config.GITHUB_TOKEN = 'ghp_sometoken';
    const service = await buildService();

    // Force the GitHub probe to fail without making a real network call.
    jest
      .spyOn(service as unknown as { probeGitHub: () => Promise<unknown> }, 'probeGitHub')
      .mockResolvedValue({
        status: 'down',
        message: 'bad credentials - the configured GITHUB_TOKEN was rejected',
        lastCheck: new Date().toISOString(),
        verified: true,
      });

    const result = await service.checkAll();

    expect(result.status).toBe('degraded');
  });
});
