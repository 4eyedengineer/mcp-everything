import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { GitHubService } from './github.service';

// Mock @octokit/rest so we control auth/search/list behavior per-test without
// hitting the network. jest.fn() instances are created inside the factory
// and re-read via requireMock in each test (jest hoists jest.mock calls).
const listForAuthenticatedUser = jest.fn();
const searchRepos = jest.fn();

jest.mock('@octokit/rest', () => {
  return {
    Octokit: jest.fn().mockImplementation((options: { auth?: string }) => ({
      __auth: options?.auth,
      rest: {
        repos: {
          listForAuthenticatedUser: (...args: unknown[]) => listForAuthenticatedUser(...args),
        },
        search: {
          repos: (...args: unknown[]) => searchRepos(...args),
        },
      },
    })),
  };
});

function buildRepo(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    full_name: 'octocat/hello-world',
    description: 'A test repo',
    stargazers_count: 42,
    html_url: 'https://github.com/octocat/hello-world',
    language: 'TypeScript',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

async function buildService(githubToken: string | undefined): Promise<GitHubService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      GitHubService,
      {
        provide: ConfigService,
        useValue: {
          get: jest.fn((key: string) => (key === 'GITHUB_TOKEN' ? githubToken : undefined)),
        },
      },
    ],
  }).compile();

  return module.get(GitHubService);
}

describe('GitHubService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('listMyRepos', () => {
    it('degrades to github_not_configured when no token is configured', async () => {
      const service = await buildService(undefined);

      const result = await service.listMyRepos();

      expect(result).toEqual({ available: false, reason: 'github_not_configured', repos: [] });
      expect(listForAuthenticatedUser).not.toHaveBeenCalled();
    });

    it('degrades to github_not_configured when the token is the .env.example placeholder', async () => {
      const service = await buildService('your-github-token-here');

      const result = await service.listMyRepos();

      expect(result.available).toBe(false);
      expect(result.reason).toBe('github_not_configured');
    });

    it('degrades to github_not_configured (200, not a throw) when the configured token is invalid', async () => {
      listForAuthenticatedUser.mockRejectedValue(
        Object.assign(new Error('Bad credentials'), { status: 401 }),
      );
      const service = await buildService('ghp_invalidtoken');

      const result = await service.listMyRepos();

      expect(result).toEqual({ available: false, reason: 'github_not_configured', repos: [] });
    });

    it('returns normalized repos when the token is valid', async () => {
      listForAuthenticatedUser.mockResolvedValue({ data: [buildRepo()] });
      const service = await buildService('ghp_validtoken');

      const result = await service.listMyRepos(1, 30);

      expect(result.available).toBe(true);
      expect(result.repos).toEqual([
        {
          fullName: 'octocat/hello-world',
          description: 'A test repo',
          stars: 42,
          url: 'https://github.com/octocat/hello-world',
          language: 'TypeScript',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ]);
    });

    it('caches successful results for subsequent calls with the same page/perPage', async () => {
      listForAuthenticatedUser.mockResolvedValue({ data: [buildRepo()] });
      const service = await buildService('ghp_validtoken');

      await service.listMyRepos(1, 30);
      await service.listMyRepos(1, 30);

      expect(listForAuthenticatedUser).toHaveBeenCalledTimes(1);
    });

    it('degrades to a generic error reason on unexpected failures', async () => {
      listForAuthenticatedUser.mockRejectedValue(new Error('ECONNRESET'));
      const service = await buildService('ghp_validtoken');

      const result = await service.listMyRepos();

      expect(result).toEqual({ available: false, reason: 'error', repos: [] });
    });
  });

  describe('searchPublicRepos', () => {
    it('searches unauthenticated when no token is configured', async () => {
      searchRepos.mockResolvedValue({ data: { items: [buildRepo()] } });
      const service = await buildService(undefined);

      const result = await service.searchPublicRepos('jsonplaceholder');

      expect(result.available).toBe(true);
      expect(result.repos[0].fullName).toBe('octocat/hello-world');
      expect(searchRepos).toHaveBeenCalledWith(
        expect.objectContaining({ q: 'jsonplaceholder' }),
      );
    });

    it('degrades to rate_limited (200, not a throw) when GitHub rate-limits the search', async () => {
      searchRepos.mockRejectedValue(
        Object.assign(new Error('API rate limit exceeded'), { status: 403 }),
      );
      const service = await buildService(undefined);

      const result = await service.searchPublicRepos('jsonplaceholder');

      expect(result).toEqual({ available: false, reason: 'rate_limited', repos: [] });
    });

    it('falls back to an unauthenticated client when the configured token fails for a non-rate-limit reason', async () => {
      searchRepos
        .mockRejectedValueOnce(Object.assign(new Error('Bad credentials'), { status: 401 }))
        .mockResolvedValueOnce({ data: { items: [buildRepo()] } });
      const service = await buildService('ghp_invalidtoken');

      const result = await service.searchPublicRepos('jsonplaceholder');

      expect(result.available).toBe(true);
      expect(searchRepos).toHaveBeenCalledTimes(2);
    });

    it('caches search results per query string', async () => {
      searchRepos.mockResolvedValue({ data: { items: [buildRepo()] } });
      const service = await buildService(undefined);

      await service.searchPublicRepos('jsonplaceholder');
      await service.searchPublicRepos('jsonplaceholder');

      expect(searchRepos).toHaveBeenCalledTimes(1);
    });
  });
});
