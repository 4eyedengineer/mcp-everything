import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Octokit } from '@octokit/rest';
import { GitHubService } from './github.service';
import { UserService } from '../user/user.service';
import { TokenEncryptionService } from '../common/token-encryption/token-encryption.service';

// Mock @octokit/rest so we control auth/search/list/get behavior per-test
// without hitting the network. jest.fn() instances are created inside the
// factory and re-read via requireMock in each test (jest hoists jest.mock
// calls).
const listForAuthenticatedUser = jest.fn();
const searchRepos = jest.fn();
const getRepo = jest.fn();

jest.mock('@octokit/rest', () => {
  return {
    Octokit: jest.fn().mockImplementation((options: { auth?: string }) => ({
      __auth: options?.auth,
      rest: {
        repos: {
          listForAuthenticatedUser: (...args: unknown[]) => listForAuthenticatedUser(...args),
          get: (...args: unknown[]) => getRepo(...args),
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
    default_branch: 'main',
    private: false,
    ...overrides,
  };
}

interface BuildOpts {
  githubToken?: string;
  githubClientId?: string;
  githubClientSecret?: string;
  /** Mocked User row as returned by UserService.findByIdWithGithubToken. */
  storedUser?: { githubAccessTokenEncrypted?: string; githubUsername?: string } | null;
  /** Mocked decrypt() behavior - defaults to identity (encrypted value === plaintext). */
  decrypt?: (payload: string | undefined | null) => string | undefined;
}

interface BuiltService {
  service: GitHubService;
  userService: { findByIdWithGithubToken: jest.Mock; clearGithubToken: jest.Mock };
  tokenEncryption: { decrypt: jest.Mock };
}

async function buildService(opts: BuildOpts = {}): Promise<BuiltService> {
  const userService = {
    findByIdWithGithubToken: jest.fn().mockResolvedValue(opts.storedUser ?? null),
    clearGithubToken: jest.fn().mockResolvedValue(undefined),
  };
  const tokenEncryption = {
    decrypt: jest.fn(opts.decrypt ?? ((payload) => payload ?? undefined)),
  };

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      GitHubService,
      {
        provide: ConfigService,
        useValue: {
          get: jest.fn((key: string) => {
            switch (key) {
              case 'GITHUB_TOKEN':
                return opts.githubToken;
              case 'GITHUB_CLIENT_ID':
                return opts.githubClientId;
              case 'GITHUB_CLIENT_SECRET':
                return opts.githubClientSecret;
              default:
                return undefined;
            }
          }),
        },
      },
      { provide: UserService, useValue: userService },
      { provide: TokenEncryptionService, useValue: tokenEncryption },
    ],
  }).compile();

  return { service: module.get(GitHubService), userService, tokenEncryption };
}

describe('GitHubService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('listMyRepos', () => {
    it('reports not_connected (200, not a throw) when the user has no stored token and no server PAT is configured', async () => {
      const { service } = await buildService({});

      const result = await service.listMyRepos('user-1');

      expect(result).toEqual({ available: false, reason: 'not_connected', connected: false, repos: [] });
      expect(listForAuthenticatedUser).not.toHaveBeenCalled();
    });

    it('reports not_connected when the token is the .env.example placeholder and the user has not connected', async () => {
      const { service } = await buildService({ githubToken: 'your-github-token-here' });

      const result = await service.listMyRepos('user-1');

      expect(result.available).toBe(false);
      expect(result.reason).toBe('not_connected');
      expect(result.connected).toBe(false);
    });

    it('uses the calling user\'s own stored token when present (source: user, connected: true)', async () => {
      listForAuthenticatedUser.mockResolvedValue({ data: [buildRepo()] });
      const { service } = await buildService({
        storedUser: { githubAccessTokenEncrypted: 'enc(gho_userToken)', githubUsername: 'octocat' },
        decrypt: () => 'gho_userToken',
      });

      const result = await service.listMyRepos('user-1', 1, 30);

      expect(result.available).toBe(true);
      expect(result.source).toBe('user');
      expect(result.connected).toBe(true);
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
      // Built the Octokit client from the user's decrypted token, not the server PAT.
      expect((Octokit as unknown as jest.Mock)).toHaveBeenCalledWith(
        expect.objectContaining({ auth: 'gho_userToken' }),
      );
    });

    it('degrades to user_token_invalid (200, not a throw) when the user\'s stored token is rejected by GitHub, without falling back to the server PAT', async () => {
      listForAuthenticatedUser.mockRejectedValue(
        Object.assign(new Error('Bad credentials'), { status: 401 }),
      );
      const { service } = await buildService({
        githubToken: 'ghp_serverpat',
        storedUser: { githubAccessTokenEncrypted: 'enc(gho_userToken)' },
        decrypt: () => 'gho_userToken',
      });

      const result = await service.listMyRepos('user-1');

      expect(result).toEqual({ available: false, reason: 'user_token_invalid', connected: true, repos: [] });
      expect(listForAuthenticatedUser).toHaveBeenCalledTimes(1);
    });

    it('falls back to the server PAT (source: server) but still reports connected:false when the user has not connected', async () => {
      listForAuthenticatedUser.mockResolvedValue({ data: [buildRepo()] });
      const { service } = await buildService({ githubToken: 'ghp_serverpat' });

      const result = await service.listMyRepos('user-1');

      expect(result.available).toBe(true);
      expect(result.source).toBe('server');
      expect(result.connected).toBe(false);
    });

    it('falls back to the server PAT but reports connected:true when the user IS connected but their token could not be decrypted', async () => {
      listForAuthenticatedUser.mockResolvedValue({ data: [buildRepo()] });
      const { service } = await buildService({
        githubToken: 'ghp_serverpat',
        storedUser: { githubAccessTokenEncrypted: 'enc(gho_userToken)' },
        decrypt: () => undefined, // TOKEN_ENCRYPTION_KEY rotated/missing
      });

      const result = await service.listMyRepos('user-1');

      expect(result.available).toBe(true);
      expect(result.source).toBe('server');
      expect(result.connected).toBe(true);
    });

    it('degrades to not_connected (200, not a throw) when the server PAT is invalid and the user has not connected', async () => {
      listForAuthenticatedUser.mockRejectedValue(
        Object.assign(new Error('Bad credentials'), { status: 401 }),
      );
      const { service } = await buildService({ githubToken: 'ghp_invalidtoken' });

      const result = await service.listMyRepos('user-1');

      expect(result).toEqual({ available: false, reason: 'not_connected', connected: false, repos: [] });
    });

    it('caches successful per-user results separately from per-server results', async () => {
      listForAuthenticatedUser.mockResolvedValue({ data: [buildRepo()] });
      const { service } = await buildService({
        githubToken: 'ghp_serverpat',
        storedUser: { githubAccessTokenEncrypted: 'enc(gho_userToken)' },
        decrypt: () => 'gho_userToken',
      });

      await service.listMyRepos('user-1', 1, 30);
      await service.listMyRepos('user-1', 1, 30);

      expect(listForAuthenticatedUser).toHaveBeenCalledTimes(1);
    });

    it('does not leak one user\'s cached repos to a different user (regression: cache must be keyed per user)', async () => {
      listForAuthenticatedUser
        .mockResolvedValueOnce({ data: [buildRepo({ full_name: 'user-1/private-repo' })] })
        .mockResolvedValueOnce({ data: [buildRepo({ full_name: 'user-2/other-repo' })] });

      const { service, userService, tokenEncryption } = await buildService({
        storedUser: { githubAccessTokenEncrypted: 'enc(gho_user1Token)' },
        decrypt: () => 'gho_user1Token',
      });

      const resultUser1 = await service.listMyRepos('user-1', 1, 30);

      // Reconfigure the same mocks to simulate a second, different user.
      userService.findByIdWithGithubToken.mockResolvedValue({
        githubAccessTokenEncrypted: 'enc(gho_user2Token)',
      });
      tokenEncryption.decrypt.mockImplementation(() => 'gho_user2Token');

      const resultUser2 = await service.listMyRepos('user-2', 1, 30);

      expect(resultUser1.repos[0].fullName).toBe('user-1/private-repo');
      expect(resultUser2.repos[0].fullName).toBe('user-2/other-repo');
      expect(listForAuthenticatedUser).toHaveBeenCalledTimes(2);
    });

    it('degrades to a generic error reason on unexpected failures', async () => {
      listForAuthenticatedUser.mockRejectedValue(new Error('ECONNRESET'));
      const { service } = await buildService({ githubToken: 'ghp_validtoken' });

      const result = await service.listMyRepos('user-1');

      expect(result).toEqual({ available: false, reason: 'error', connected: false, repos: [] });
    });
  });

  describe('searchPublicRepos', () => {
    it('searches unauthenticated when no token is configured', async () => {
      searchRepos.mockResolvedValue({ data: { items: [buildRepo()] } });
      const { service } = await buildService({});

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
      const { service } = await buildService({});

      const result = await service.searchPublicRepos('jsonplaceholder');

      expect(result).toEqual({ available: false, reason: 'rate_limited', repos: [] });
    });

    it('falls back to an unauthenticated client when the configured token fails for a non-rate-limit reason', async () => {
      searchRepos
        .mockRejectedValueOnce(Object.assign(new Error('Bad credentials'), { status: 401 }))
        .mockResolvedValueOnce({ data: { items: [buildRepo()] } });
      const { service } = await buildService({ githubToken: 'ghp_invalidtoken' });

      const result = await service.searchPublicRepos('jsonplaceholder');

      expect(result.available).toBe(true);
      expect(searchRepos).toHaveBeenCalledTimes(2);
    });

    it('caches search results per query string', async () => {
      searchRepos.mockResolvedValue({ data: { items: [buildRepo()] } });
      const { service } = await buildService({});

      await service.searchPublicRepos('jsonplaceholder');
      await service.searchPublicRepos('jsonplaceholder');

      expect(searchRepos).toHaveBeenCalledTimes(1);
    });
  });

  describe('checkRepoExists', () => {
    it('returns status "exists" with normalized metadata for a real repo', async () => {
      getRepo.mockResolvedValue({ data: buildRepo({ full_name: 'octocat/hello-world' }) });
      const { service } = await buildService({});

      const result = await service.checkRepoExists(undefined, 'octocat', 'hello-world');

      expect(result).toEqual({
        status: 'exists',
        repo: {
          fullName: 'octocat/hello-world',
          description: 'A test repo',
          defaultBranch: 'main',
          private: false,
          stars: 42,
        },
      });
    });

    it('returns status "not_found" (200, not a throw) for a 404', async () => {
      getRepo.mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 }));
      const { service } = await buildService({});

      const result = await service.checkRepoExists(undefined, 'nobody', 'nothing-here');

      expect(result).toEqual({ status: 'not_found' });
    });

    it('returns status "unknown"/rate_limited (never "not_found") when GitHub rate-limits the check', async () => {
      getRepo.mockRejectedValue(
        Object.assign(new Error('API rate limit exceeded'), { status: 403 }),
      );
      const { service } = await buildService({});

      const result = await service.checkRepoExists(undefined, 'someone', 'somerepo');

      expect(result).toEqual({ status: 'unknown', reason: 'rate_limited' });
    });

    it('returns status "unknown"/error on unexpected failures', async () => {
      getRepo.mockRejectedValue(new Error('ECONNRESET'));
      const { service } = await buildService({});

      const result = await service.checkRepoExists(undefined, 'someone', 'somerepo');

      expect(result).toEqual({ status: 'unknown', reason: 'error' });
    });

    it('prefers the calling user\'s own token over the server PAT when resolving credentials', async () => {
      getRepo.mockResolvedValue({ data: buildRepo() });
      const { service } = await buildService({
        githubToken: 'ghp_serverpat',
        storedUser: { githubAccessTokenEncrypted: 'enc(gho_userToken)' },
        decrypt: () => 'gho_userToken',
      });

      await service.checkRepoExists('user-1', 'octocat', 'hello-world');

      expect((Octokit as unknown as jest.Mock)).toHaveBeenCalledWith(
        expect.objectContaining({ auth: 'gho_userToken' }),
      );
    });

    it('falls back to an unauthenticated check (and still finds the repo) when the server PAT is invalid - never a false "not_found"/"unknown" caused by a bad server credential', async () => {
      getRepo
        .mockRejectedValueOnce(Object.assign(new Error('Bad credentials'), { status: 401 }))
        .mockResolvedValueOnce({ data: buildRepo({ full_name: 'modelcontextprotocol/servers' }) });
      const { service } = await buildService({ githubToken: 'ghp_invalidtoken' });

      const result = await service.checkRepoExists(undefined, 'modelcontextprotocol', 'servers');

      expect(result.status).toBe('exists');
      expect(result.repo?.fullName).toBe('modelcontextprotocol/servers');
      expect(getRepo).toHaveBeenCalledTimes(2);
    });

    it('reports not_found when the unauthenticated fallback also 404s after the server PAT fails', async () => {
      getRepo
        .mockRejectedValueOnce(Object.assign(new Error('Bad credentials'), { status: 401 }))
        .mockRejectedValueOnce(Object.assign(new Error('Not Found'), { status: 404 }));
      const { service } = await buildService({ githubToken: 'ghp_invalidtoken' });

      const result = await service.checkRepoExists(undefined, 'nobody', 'nothing-here');

      expect(result).toEqual({ status: 'not_found' });
    });
  });

  describe('getConnectionStatus', () => {
    it('reports connected:true with the username when the user has a stored token', async () => {
      const { service } = await buildService({
        storedUser: { githubAccessTokenEncrypted: 'enc(gho_userToken)', githubUsername: 'octocat' },
      });

      const result = await service.getConnectionStatus('user-1');

      expect(result).toEqual({ connected: true, username: 'octocat' });
    });

    it('reports connected:false when the user has no stored token', async () => {
      const { service } = await buildService({ storedUser: null });

      const result = await service.getConnectionStatus('user-1');

      expect(result).toEqual({ connected: false, username: null });
    });
  });

  describe('disconnect', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('revokes the token upstream with GitHub then clears the local copy', async () => {
      const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 204 });
      global.fetch = fetchMock as unknown as typeof fetch;

      const { service, userService } = await buildService({
        githubClientId: 'client-id',
        githubClientSecret: 'client-secret',
        storedUser: { githubAccessTokenEncrypted: 'enc(gho_userToken)' },
        decrypt: () => 'gho_userToken',
      });

      await service.disconnect('user-1');

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.github.com/applications/client-id/token',
        expect.objectContaining({ method: 'DELETE' }),
      );
      expect(userService.clearGithubToken).toHaveBeenCalledWith('user-1');
    });

    it('never includes the plaintext token in the request URL (only in the signed body)', async () => {
      const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 204 });
      global.fetch = fetchMock as unknown as typeof fetch;

      const { service } = await buildService({
        githubClientId: 'client-id',
        githubClientSecret: 'client-secret',
        storedUser: { githubAccessTokenEncrypted: 'enc(gho_userToken)' },
        decrypt: () => 'gho_userToken',
      });

      await service.disconnect('user-1');

      const [url] = fetchMock.mock.calls[0];
      expect(url).not.toContain('gho_userToken');
    });

    it('still clears the local token when GITHUB_CLIENT_ID/SECRET are not configured (skips upstream revocation)', async () => {
      const fetchMock = jest.fn();
      global.fetch = fetchMock as unknown as typeof fetch;

      const { service, userService } = await buildService({
        storedUser: { githubAccessTokenEncrypted: 'enc(gho_userToken)' },
        decrypt: () => 'gho_userToken',
      });

      await service.disconnect('user-1');

      expect(fetchMock).not.toHaveBeenCalled();
      expect(userService.clearGithubToken).toHaveBeenCalledWith('user-1');
    });

    it('still clears the local token when the upstream revocation call throws (network error)', async () => {
      const fetchMock = jest.fn().mockRejectedValue(new Error('network down'));
      global.fetch = fetchMock as unknown as typeof fetch;

      const { service, userService } = await buildService({
        githubClientId: 'client-id',
        githubClientSecret: 'client-secret',
        storedUser: { githubAccessTokenEncrypted: 'enc(gho_userToken)' },
        decrypt: () => 'gho_userToken',
      });

      await expect(service.disconnect('user-1')).resolves.toBeUndefined();
      expect(userService.clearGithubToken).toHaveBeenCalledWith('user-1');
    });

    it('is a no-op upstream call when the user had no stored token to revoke', async () => {
      const fetchMock = jest.fn();
      global.fetch = fetchMock as unknown as typeof fetch;

      const { service, userService } = await buildService({ storedUser: null });

      await service.disconnect('user-1');

      expect(fetchMock).not.toHaveBeenCalled();
      expect(userService.clearGithubToken).toHaveBeenCalledWith('user-1');
    });
  });
});
