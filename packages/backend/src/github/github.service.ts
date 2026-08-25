import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Octokit } from '@octokit/rest';
import { UserService } from '../user/user.service';
import { TokenEncryptionService } from '../common/token-encryption/token-encryption.service';
import {
  GitHubRepoEntry,
  GitHubReposResponse,
  GitHubConnectionStatusDto,
  GitHubRepoExistsResponse,
} from './types/github-repo.types';

interface CacheEntry {
  expiresAt: number;
  response: GitHubReposResponse;
}

/**
 * GitHubService
 *
 * Backs the repo-picker modal on the chat page ("Analyze a GitHub
 * repository" suggestion card). Capabilities:
 *
 *  - listMyRepos: the CALLING USER's own repositories, using their stored
 *    GitHub OAuth token (see TokenEncryptionService / User.githubAccessTokenEncrypted).
 *    Falls back to the server-wide GITHUB_TOKEN PAT when the caller hasn't
 *    connected their own account - `source`/`connected` on the response let
 *    the UI say honestly whose repos are being shown.
 *  - searchPublicRepos: GitHub's public repo search, which works even
 *    unauthenticated (at a much lower rate limit).
 *  - checkRepoExists: cheap existence pre-flight for a hand-typed repo URL,
 *    using the same credential-resolution order as listMyRepos.
 *  - getConnectionStatus / disconnect: connect-account status and the
 *    "Disconnect GitHub" flow (also revokes the token upstream with GitHub).
 *
 * All of the above degrade to a typed "not available" result with a 200
 * status instead of throwing, so the UI can always fall back to "paste a
 * URL" without a broken error state.
 */
@Injectable()
export class GitHubService {
  private readonly logger = new Logger(GitHubService.name);

  /** Server-wide fallback client, or undefined when no usable PAT is configured. */
  private readonly authedOctokit: Octokit | undefined;
  /** Always-available unauthenticated fallback for public search/existence checks. */
  private readonly publicOctokit: Octokit;

  private readonly cache = new Map<string, CacheEntry>();
  private readonly CACHE_TTL_MS = 60_000;

  constructor(
    private readonly configService: ConfigService,
    private readonly userService: UserService,
    private readonly tokenEncryption: TokenEncryptionService,
  ) {
    const token = this.configService.get<string>('GITHUB_TOKEN');
    const hasToken = Boolean(token && token !== 'your-github-token-here');

    this.authedOctokit = hasToken
      ? new Octokit({ auth: token, request: { timeout: 15_000 } })
      : undefined;
    this.publicOctokit = new Octokit({ request: { timeout: 15_000 } });
  }

  /**
   * Resolve a per-user Octokit client from the caller's stored (encrypted)
   * GitHub token, if any. Returns `connected: true` whenever the user has a
   * stored token at all - even if it couldn't be decrypted or used to build
   * a client - so callers can distinguish "not connected" from "connected,
   * but currently unusable".
   */
  /**
   * Look up and decrypt the given user's stored GitHub OAuth token, if any.
   * Shared by `resolveUserOctokit` (below) and `getUserAccessToken` (the
   * public entry point other modules use when they need the raw token
   * rather than an Octokit client already scoped to this service's own
   * defaults - e.g. DeploymentModule's GistProvider, which must create
   * Gists under the user's own account, not a platform-owned one).
   */
  private async resolveUserToken(
    userId: string | undefined,
  ): Promise<{ token: string | undefined; connected: boolean }> {
    if (!userId) {
      return { token: undefined, connected: false };
    }

    const user = await this.userService.findByIdWithGithubToken(userId);
    const encrypted = user?.githubAccessTokenEncrypted;
    if (!encrypted) {
      return { token: undefined, connected: false };
    }

    const token = this.tokenEncryption.decrypt(encrypted);
    if (!token) {
      this.logger.warn(
        `Stored GitHub token for user ${userId} could not be decrypted - degrading as if not connected`,
      );
      return { token: undefined, connected: true };
    }

    return { token, connected: true };
  }

  private async resolveUserOctokit(
    userId: string | undefined,
  ): Promise<{ octokit: Octokit | undefined; connected: boolean }> {
    const { token, connected } = await this.resolveUserToken(userId);
    if (!token) {
      return { octokit: undefined, connected };
    }

    return {
      octokit: new Octokit({ auth: token, request: { timeout: 15_000 } }),
      connected: true,
    };
  }

  /**
   * Decrypt and return the given user's stored GitHub OAuth access token,
   * or `undefined` when the user has no usable stored token (never
   * connected GitHub, or the stored token couldn't be decrypted). Unlike
   * `resolveUserOctokit`, this does not build an Octokit client - callers
   * that need a client scoped to a specific purpose (e.g. Gist creation)
   * build their own from the returned token. There is deliberately no
   * server-wide-PAT fallback here: a token returned from this method is
   * always the calling user's own, never the platform's.
   */
  async getUserAccessToken(userId: string | undefined): Promise<string | undefined> {
    const { token } = await this.resolveUserToken(userId);
    return token;
  }

  /**
   * List the calling user's own repositories. Tries the user's stored
   * GitHub token first; falls back to the server-configured GITHUB_TOKEN PAT
   * (labeled via `source: 'server'`) when the user hasn't connected their
   * own account. Returns `available: false` (200, not an error) when
   * neither is usable.
   */
  async listMyRepos(
    userId: string | undefined,
    page = 1,
    perPage = 30,
  ): Promise<GitHubReposResponse> {
    const { octokit: userOctokit, connected } = await this.resolveUserOctokit(userId);

    if (userOctokit) {
      const cacheKey = `repos:user:${userId}:${page}:${perPage}`;
      const cached = this.getCached(cacheKey);
      if (cached) return cached;

      try {
        const response = await userOctokit.rest.repos.listForAuthenticatedUser({
          page,
          per_page: perPage,
          sort: 'updated',
        });

        const result: GitHubReposResponse = {
          available: true,
          source: 'user',
          connected: true,
          repos: response.data.map((repo) => this.toRepoEntry(repo)),
        };
        this.setCached(cacheKey, result);
        return result;
      } catch (error) {
        const status = (error as { status?: number })?.status;
        if (status === 401 || status === 403) {
          this.logger.warn(
            `Stored GitHub token for user ${userId} rejected by GitHub API (status ${status})`,
          );
          return { available: false, reason: 'user_token_invalid', connected: true, repos: [] };
        }
        this.logger.error(
          `Failed to list repositories for user ${userId}: ${(error as Error).message}`,
        );
        return { available: false, reason: 'error', connected: true, repos: [] };
      }
    }

    // No usable per-user token - fall back to the server-configured PAT, if
    // any, but always report the caller's real connection state so the UI
    // can tell "these are the server account's repos" from "these are yours".
    if (!this.authedOctokit) {
      return { available: false, reason: 'not_connected', connected, repos: [] };
    }

    const cacheKey = `repos:server:${page}:${perPage}`;
    const cached = this.getCached(cacheKey);
    if (cached) return { ...cached, connected };

    try {
      const response = await this.authedOctokit.rest.repos.listForAuthenticatedUser({
        page,
        per_page: perPage,
        sort: 'updated',
      });

      const result: GitHubReposResponse = {
        available: true,
        source: 'server',
        connected,
        repos: response.data.map((repo) => this.toRepoEntry(repo)),
      };
      this.setCached(cacheKey, result);
      return result;
    } catch (error) {
      const status = (error as { status?: number })?.status;
      if (status === 401 || status === 403) {
        this.logger.warn(
          `Server GITHUB_TOKEN rejected by GitHub API (status ${status}) - degrading to unconfigured`,
        );
        // Not cached: a fixed token doesn't need a 60s TTL to recover from.
        return { available: false, reason: 'not_connected', connected, repos: [] };
      }
      this.logger.error(`Failed to list repositories: ${(error as Error).message}`);
      return { available: false, reason: 'error', connected, repos: [] };
    }
  }

  /**
   * Search public GitHub repositories. Uses the authenticated client when a
   * valid token is configured (higher rate limit), otherwise falls back to
   * an unauthenticated client - GitHub's search API permits this at a lower
   * rate limit (10 req/min unauthenticated vs 30 req/min authenticated).
   */
  async searchPublicRepos(query: string, page = 1, perPage = 10): Promise<GitHubReposResponse> {
    const cacheKey = `search:${query}:${page}:${perPage}`;
    const cached = this.getCached(cacheKey);
    if (cached) return cached;

    const client = this.authedOctokit ?? this.publicOctokit;

    try {
      const response = await client.rest.search.repos({
        q: query,
        page,
        per_page: perPage,
      });

      const result: GitHubReposResponse = {
        available: true,
        repos: response.data.items.map((repo) => this.toRepoEntry(repo)),
      };
      this.setCached(cacheKey, result);
      return result;
    } catch (error) {
      if (this.isRateLimitError(error)) {
        this.logger.warn(`GitHub search rate-limited: ${(error as Error).message}`);
        return { available: false, reason: 'rate_limited', repos: [] };
      }

      // If the authenticated client failed for a reason unrelated to rate
      // limiting (e.g. invalid token), retry once unauthenticated before
      // giving up - search works fine without auth.
      if (client === this.authedOctokit) {
        try {
          const fallback = await this.publicOctokit.rest.search.repos({
            q: query,
            page,
            per_page: perPage,
          });
          const result: GitHubReposResponse = {
            available: true,
            repos: fallback.data.items.map((repo) => this.toRepoEntry(repo)),
          };
          this.setCached(cacheKey, result);
          return result;
        } catch (fallbackError) {
          if (this.isRateLimitError(fallbackError)) {
            return { available: false, reason: 'rate_limited', repos: [] };
          }
          this.logger.error(`GitHub search failed: ${(fallbackError as Error).message}`);
          return { available: false, reason: 'error', repos: [] };
        }
      }

      this.logger.error(`GitHub search failed: ${(error as Error).message}`);
      return { available: false, reason: 'error', repos: [] };
    }
  }

  /**
   * Cheap existence/metadata pre-flight for a repo the user typed in by
   * hand, so the repo-picker modal can refuse to kick off a (paid)
   * generation run against a repo that doesn't exist. Uses the same
   * credential-resolution order as listMyRepos (user token -> server PAT ->
   * unauthenticated), since `repos.get` works unauthenticated for public repos.
   *
   * If the resolved (authenticated) client fails for a reason unrelated to
   * "doesn't exist" or rate limiting - e.g. an invalid token, which is the
   * live state of the server PAT in this environment - retries once
   * unauthenticated before giving up, exactly like `searchPublicRepos`. This
   * matters a lot here specifically: a false "not_found"/"unknown" caused by
   * a bad *server* credential must never block the user from analyzing a
   * repo that actually exists.
   */
  async checkRepoExists(
    userId: string | undefined,
    owner: string,
    repo: string,
  ): Promise<GitHubRepoExistsResponse> {
    const { octokit: userOctokit } = await this.resolveUserOctokit(userId);
    const client = userOctokit ?? this.authedOctokit ?? this.publicOctokit;

    try {
      return await this.fetchRepoExists(client, owner, repo);
    } catch (error) {
      const status = (error as { status?: number })?.status;
      if (status === 404) {
        return { status: 'not_found' };
      }
      if (this.isRateLimitError(error)) {
        this.logger.warn(`repo-exists check rate-limited for ${owner}/${repo}`);
        return { status: 'unknown', reason: 'rate_limited' };
      }

      if (client !== this.publicOctokit) {
        try {
          return await this.fetchRepoExists(this.publicOctokit, owner, repo);
        } catch (fallbackError) {
          const fallbackStatus = (fallbackError as { status?: number })?.status;
          if (fallbackStatus === 404) {
            return { status: 'not_found' };
          }
          if (this.isRateLimitError(fallbackError)) {
            return { status: 'unknown', reason: 'rate_limited' };
          }
          this.logger.warn(
            `repo-exists check failed for ${owner}/${repo}: ${(fallbackError as Error).message}`,
          );
          return { status: 'unknown', reason: 'error' };
        }
      }

      this.logger.warn(
        `repo-exists check failed for ${owner}/${repo}: ${(error as Error).message}`,
      );
      return { status: 'unknown', reason: 'error' };
    }
  }

  private async fetchRepoExists(
    client: Octokit,
    owner: string,
    repo: string,
  ): Promise<GitHubRepoExistsResponse> {
    const response = await client.rest.repos.get({ owner, repo });
    return {
      status: 'exists',
      repo: {
        fullName: response.data.full_name,
        description: response.data.description ?? null,
        defaultBranch: response.data.default_branch,
        private: response.data.private,
        stars: response.data.stargazers_count ?? 0,
      },
    };
  }

  /** Whether the given user has a GitHub account connected (a stored token), and their username. */
  async getConnectionStatus(userId: string): Promise<GitHubConnectionStatusDto> {
    const user = await this.userService.findByIdWithGithubToken(userId);
    return {
      connected: Boolean(user?.githubAccessTokenEncrypted),
      username: user?.githubUsername ?? null,
    };
  }

  /**
   * Disconnect the user's GitHub account: revoke the token upstream with
   * GitHub (best-effort - a failure here doesn't block clearing our copy,
   * since a stale local credential is worse than a token GitHub couldn't
   * confirm revoking), then clear the stored (encrypted) token locally.
   */
  async disconnect(userId: string): Promise<void> {
    const user = await this.userService.findByIdWithGithubToken(userId);
    const encrypted = user?.githubAccessTokenEncrypted;

    if (encrypted) {
      const token = this.tokenEncryption.decrypt(encrypted);
      if (token) {
        await this.revokeTokenUpstream(token);
      }
    }

    await this.userService.clearGithubToken(userId);
    this.clearUserCache(userId);
    this.logger.log(`GitHub account disconnected for user ${userId}`);
  }

  /**
   * Ask GitHub to revoke an OAuth App token (DELETE /applications/{client_id}/token,
   * authenticated with the app's client id/secret via HTTP Basic auth - this is
   * NOT the same as calling the API with the token itself). Best-effort: logs
   * and returns on failure rather than throwing, so disconnect always still
   * clears our local copy.
   */
  private async revokeTokenUpstream(token: string): Promise<void> {
    const clientId = this.configService.get<string>('GITHUB_CLIENT_ID');
    const clientSecret = this.configService.get<string>('GITHUB_CLIENT_SECRET');

    if (!clientId || !clientSecret) {
      this.logger.warn(
        'GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET not configured - skipping upstream token ' +
          'revocation, only the locally stored copy will be removed',
      );
      return;
    }

    try {
      const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
      const response = await fetch(`https://api.github.com/applications/${clientId}/token`, {
        method: 'DELETE',
        headers: {
          Authorization: `Basic ${basicAuth}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({ access_token: token }),
      });

      if (!response.ok && response.status !== 404) {
        this.logger.warn(
          `GitHub token revocation returned status ${response.status} - removing the local copy anyway`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Failed to reach GitHub to revoke the token upstream: ${(error as Error).message} - ` +
          'removing the local copy anyway',
      );
    }
  }

  private isRateLimitError(error: unknown): boolean {
    const status = (error as { status?: number })?.status;
    if (status !== 403 && status !== 429) return false;
    const message = (error as Error)?.message?.toLowerCase() || '';
    return (
      status === 429 ||
      message.includes('rate limit') ||
      message.includes('secondary rate limit') ||
      message.includes('abuse detection')
    );
  }

  private toRepoEntry(repo: {
    full_name: string;
    description?: string | null;
    stargazers_count?: number;
    html_url: string;
    language?: string | null;
    updated_at?: string | null;
  }): GitHubRepoEntry {
    return {
      fullName: repo.full_name,
      description: repo.description ?? null,
      stars: repo.stargazers_count ?? 0,
      url: repo.html_url,
      language: repo.language ?? null,
      updatedAt: repo.updated_at ?? null,
    };
  }

  private getCached(key: string): GitHubReposResponse | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.response;
  }

  private setCached(key: string, response: GitHubReposResponse): void {
    this.cache.set(key, { expiresAt: Date.now() + this.CACHE_TTL_MS, response });
  }

  private clearUserCache(userId: string): void {
    const prefix = `repos:user:${userId}:`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }
}
