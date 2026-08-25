import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { API_V1_BASE } from '../config/api.config';

/** Whose repositories `GitHubReposResponse.repos` belongs to, when `available` is true. */
export type GitHubRepoSource = 'user' | 'server';

export type GitHubUnavailableReason =
  /** Caller has no stored GitHub token, and no (working) server-configured fallback either. */
  | 'not_connected'
  /** Caller has a stored GitHub token, but GitHub rejected it (expired/revoked). */
  | 'user_token_invalid'
  | 'rate_limited'
  | 'error';

export interface GitHubRepoEntry {
  fullName: string;
  description: string | null;
  stars: number;
  url: string;
  language: string | null;
  updatedAt: string | null;
}

export interface GitHubReposResponse {
  available: boolean;
  reason?: GitHubUnavailableReason;
  /** Present when `available` is true: whose repos these actually are. */
  source?: GitHubRepoSource;
  /**
   * Whether the CALLING user has a GitHub account connected (a stored
   * token), independent of whether this call succeeded - lets the UI say
   * "these are your repos" vs. "these are the server-configured account's
   * repos, you haven't connected your own" even when `source` is `'server'`.
   */
  connected?: boolean;
  repos: GitHubRepoEntry[];
}

/** Response for GET /api/v1/github/connection. */
export interface GitHubConnectionStatus {
  connected: boolean;
  username?: string | null;
}

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

/**
 * Backs the repo-picker modal opened from the chat page's "Analyze a GitHub
 * repository" suggestion card, and the account page's "Connect/Disconnect
 * GitHub" affordance. The repo-listing/existence endpoints always resolve
 * with a typed "not available"/"unknown" result rather than erroring when
 * GitHub isn't reachable/configured - callers should check `.available`/
 * `.status` rather than relying on the observable's error branch for those
 * cases.
 */
@Injectable({
  providedIn: 'root',
})
export class GitHubService {
  private readonly apiUrl = `${API_V1_BASE}/github`;

  constructor(private http: HttpClient) {}

  /**
   * The calling user's own repositories (via their connected GitHub
   * account), falling back to the server-configured GITHUB_TOKEN when they
   * haven't connected one. See `GitHubReposResponse.source`/`connected`.
   */
  listMyRepos(page = 1, perPage = 30): Observable<GitHubReposResponse> {
    const params = new HttpParams().set('page', page).set('per_page', perPage);
    return this.http.get<GitHubReposResponse>(`${this.apiUrl}/repos`, { params });
  }

  /** Public GitHub repo search (works without a configured token). */
  searchPublicRepos(query: string, page = 1, perPage = 10): Observable<GitHubReposResponse> {
    const params = new HttpParams().set('q', query).set('page', page).set('per_page', perPage);
    return this.http.get<GitHubReposResponse>(`${this.apiUrl}/search`, { params });
  }

  /**
   * Cheap existence/metadata pre-flight for a hand-typed repo reference -
   * used to stop a typo'd or dead repo URL from kicking off a (paid)
   * generation run. `status: 'unknown'` means the check was inconclusive
   * (rate limited/network error) - callers should NOT treat that the same
   * as `'not_found'`.
   */
  checkRepoExists(owner: string, repo: string): Observable<GitHubRepoExistsResponse> {
    const params = new HttpParams().set('owner', owner).set('repo', repo);
    return this.http.get<GitHubRepoExistsResponse>(`${this.apiUrl}/repo-exists`, { params });
  }

  /** Whether the current user has a GitHub account connected. */
  getConnectionStatus(): Observable<GitHubConnectionStatus> {
    return this.http.get<GitHubConnectionStatus>(`${this.apiUrl}/connection`);
  }

  /**
   * Disconnect the current user's GitHub account - the backend revokes the
   * token with GitHub, then clears the locally stored copy.
   */
  disconnect(): Observable<{ success: boolean }> {
    return this.http.delete<{ success: boolean }>(`${this.apiUrl}/connection`);
  }
}
