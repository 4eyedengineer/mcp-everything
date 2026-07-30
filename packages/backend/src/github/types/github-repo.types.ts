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

/** Reason the endpoint degraded to `available: false` instead of erroring. */
export type GitHubUnavailableReason = 'github_not_configured' | 'rate_limited' | 'error';

export interface GitHubReposResponse {
  available: boolean;
  reason?: GitHubUnavailableReason;
  repos: GitHubRepoEntry[];
}
