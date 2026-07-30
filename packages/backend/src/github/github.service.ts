import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Octokit } from '@octokit/rest';
import { GitHubRepoEntry, GitHubReposResponse } from './types/github-repo.types';

interface CacheEntry {
  expiresAt: number;
  response: GitHubReposResponse;
}

/**
 * GitHubService
 *
 * Backs the repo-picker modal on the chat page ("Analyze a GitHub
 * repository" suggestion card). Two read-only capabilities:
 *
 *  - listMyRepos: the server-configured GITHUB_TOKEN's own repositories
 *    (requires a valid token; degrades gracefully otherwise)
 *  - searchPublicRepos: GitHub's public repo search, which works even
 *    unauthenticated (at a much lower rate limit)
 *
 * Both degrade to `{ available: false, reason, repos: [] }` with a 200
 * status instead of throwing, so the UI can always fall back to "paste a
 * URL" without a broken error state - the configured token in this
 * environment is currently invalid, so the degradation path is the common
 * case, not an edge case.
 */
@Injectable()
export class GitHubService {
  private readonly logger = new Logger(GitHubService.name);

  /** Authenticated client, or undefined when no usable token is configured. */
  private readonly authedOctokit: Octokit | undefined;
  /** Always-available unauthenticated fallback for public search. */
  private readonly publicOctokit: Octokit;

  private readonly cache = new Map<string, CacheEntry>();
  private readonly CACHE_TTL_MS = 60_000;

  constructor(private readonly configService: ConfigService) {
    const token = this.configService.get<string>('GITHUB_TOKEN');
    const hasToken = Boolean(token && token !== 'your-github-token-here');

    this.authedOctokit = hasToken
      ? new Octokit({ auth: token, request: { timeout: 15_000 } })
      : undefined;
    this.publicOctokit = new Octokit({ request: { timeout: 15_000 } });
  }

  /**
   * List repositories owned by (or accessible to) the configured
   * GITHUB_TOKEN's user. Returns `available: false` (200, not an error) when
   * no token is configured or the token is invalid/expired.
   */
  async listMyRepos(page = 1, perPage = 30): Promise<GitHubReposResponse> {
    if (!this.authedOctokit) {
      return { available: false, reason: 'github_not_configured', repos: [] };
    }

    const cacheKey = `repos:${page}:${perPage}`;
    const cached = this.getCached(cacheKey);
    if (cached) return cached;

    try {
      const response = await this.authedOctokit.rest.repos.listForAuthenticatedUser({
        page,
        per_page: perPage,
        sort: 'updated',
      });

      const result: GitHubReposResponse = {
        available: true,
        repos: response.data.map((repo) => this.toRepoEntry(repo)),
      };
      this.setCached(cacheKey, result);
      return result;
    } catch (error) {
      const status = (error as { status?: number })?.status;
      if (status === 401 || status === 403) {
        this.logger.warn(
          `GITHUB_TOKEN rejected by GitHub API (status ${status}) - degrading to unconfigured`,
        );
        // Not cached: a fixed token doesn't need a 60s TTL to recover from.
        return { available: false, reason: 'github_not_configured', repos: [] };
      }
      this.logger.error(`Failed to list repositories: ${(error as Error).message}`);
      return { available: false, reason: 'error', repos: [] };
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
}
