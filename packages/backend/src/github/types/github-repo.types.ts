/**
 * Normalized repository entry returned by both /github/repos and
 * /github/search - shared shape so the frontend's repo-picker modal can
 * render either list with the same template.
 */
export interface GitHubRepoEntry {
  fullName: string;
  description: string | null;
  stars: number;
  url: string;
  language: string | null;
  updatedAt: string | null;
}

/** Whose repositories `GitHubReposResponse.repos` belongs to, when `available` is true. */
export type GitHubRepoSource = 'user' | 'server';

/** Reason the endpoint degraded to `available: false` instead of erroring. */
export type GitHubUnavailableReason =
  /** Caller has no stored GitHub token, and no (working) server-configured fallback either. */
  | 'not_connected'
  /** Caller has a stored GitHub token, but GitHub rejected it (expired/revoked). */
  | 'user_token_invalid'
  | 'rate_limited'
  | 'error';

export interface GitHubReposResponse {
  available: boolean;
  reason?: GitHubUnavailableReason;
  /** Present when `available` is true: whose repos these actually are. */
  source?: GitHubRepoSource;
  /**
   * Whether the CALLING user has a GitHub account connected (i.e. has a
   * stored token), independent of whether this particular call succeeded -
   * lets the UI distinguish "these are your repos" from "these are the
   * server-configured account's repos, you haven't connected your own yet"
   * even when `source` is `'server'`. Omitted by the unauthenticated public
   * search endpoint, where it isn't meaningful.
   */
  connected?: boolean;
  repos: GitHubRepoEntry[];
}

/** Response for GET /api/v1/github/connection. */
export interface GitHubConnectionStatusDto {
  connected: boolean;
  username?: string | null;
}

/** Outcome of a repo-existence pre-flight check (GET /api/v1/github/repo-exists). */
export type GitHubRepoExistsStatus = 'exists' | 'not_found' | 'unknown';

export interface GitHubRepoExistsInfo {
  fullName: string;
  description: string | null;
  defaultBranch: string;
  private: boolean;
  stars: number;
}

export interface GitHubRepoExistsResponse {
  status: GitHubRepoExistsStatus;
  /** Present when status === 'unknown': why we couldn't tell. */
  reason?: 'rate_limited' | 'error';
  /** Present when status === 'exists'. */
  repo?: GitHubRepoExistsInfo;
}
