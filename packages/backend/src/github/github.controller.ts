import { Controller, Delete, Get, HttpCode, HttpStatus, Query } from '@nestjs/common';
import { GitHubService } from './github.service';
import { ListReposQueryDto, SearchReposQueryDto, RepoExistsQueryDto } from './dto/github-query.dto';
import {
  GitHubReposResponse,
  GitHubConnectionStatusDto,
  GitHubRepoExistsResponse,
} from './types/github-repo.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

/**
 * Read-only GitHub repo listing/search/existence-check used by the chat
 * page's repo-picker modal, plus the account page's "Connect/Disconnect
 * GitHub" affordance. Protected by the global JWT guard like every other
 * route - callers must be logged in.
 */
@Controller('api/v1/github')
export class GitHubController {
  constructor(private readonly githubService: GitHubService) {}

  /**
   * The calling user's own repositories (via their stored GitHub token),
   * falling back to the server-configured GITHUB_TOKEN when they haven't
   * connected their own account. See `GitHubReposResponse.source`/`connected`
   * for how to tell those cases apart.
   */
  @Get('repos')
  async listRepos(
    @CurrentUser('id') userId: string,
    @Query() query: ListReposQueryDto,
  ): Promise<GitHubReposResponse> {
    return this.githubService.listMyRepos(userId, query.page ?? 1, query.per_page ?? 30);
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

  /**
   * Cheap existence pre-flight for a hand-typed repo URL/reference, so the
   * repo-picker modal can refuse to kick off a (paid) generation run
   * against a repo that doesn't exist.
   */
  @Get('repo-exists')
  async repoExists(
    @CurrentUser('id') userId: string,
    @Query() query: RepoExistsQueryDto,
  ): Promise<GitHubRepoExistsResponse> {
    return this.githubService.checkRepoExists(userId, query.owner, query.repo);
  }

  /** Whether the calling user has a GitHub account connected. */
  @Get('connection')
  async connectionStatus(@CurrentUser('id') userId: string): Promise<GitHubConnectionStatusDto> {
    return this.githubService.getConnectionStatus(userId);
  }

  /**
   * Disconnect the calling user's GitHub account: revokes the token
   * upstream with GitHub, then clears the locally stored copy.
   */
  @Delete('connection')
  @HttpCode(HttpStatus.OK)
  async disconnect(@CurrentUser('id') userId: string): Promise<{ success: boolean }> {
    await this.githubService.disconnect(userId);
    return { success: true };
  }
}
