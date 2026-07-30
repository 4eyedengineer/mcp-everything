import { Controller, Get, Query } from '@nestjs/common';
import { GitHubService } from './github.service';
import { ListReposQueryDto, SearchReposQueryDto } from './dto/github-query.dto';
import { GitHubReposResponse } from './types/github-repo.types';

/**
 * Read-only GitHub repo listing/search used by the chat page's repo-picker
 * modal. Protected by the global JWT guard like every other route - callers
 * must be logged in, but there's no per-user GitHub token: both endpoints
 * read from the single server-configured GITHUB_TOKEN (or degrade to
 * unauthenticated search when it's absent/invalid).
 */
@Controller('api/v1/github')
export class GitHubController {
  constructor(private readonly githubService: GitHubService) {}

  /**
   * The configured GITHUB_TOKEN's own repositories. Returns
   * `{ available: false, reason: 'github_not_configured', repos: [] }`
   * (200, not an error) when no token is configured or it's invalid.
   */
  @Get('repos')
  async listRepos(@Query() query: ListReposQueryDto): Promise<GitHubReposResponse> {
    return this.githubService.listMyRepos(query.page ?? 1, query.per_page ?? 30);
  }

  /**
   * Public GitHub repo search. Works even when no token is configured
   * (unauthenticated, lower rate limit). Returns
   * `{ available: false, reason: 'rate_limited', repos: [] }` (200, not an
   * error) if GitHub's rate limit is hit.
   */
  @Get('search')
  async search(@Query() query: SearchReposQueryDto): Promise<GitHubReposResponse> {
    return this.githubService.searchPublicRepos(query.q, query.page ?? 1, query.per_page ?? 10);
  }
}
