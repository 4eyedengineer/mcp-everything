import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { API_V1_BASE } from '../config/api.config';

export type GitHubUnavailableReason = 'github_not_configured' | 'rate_limited' | 'error';

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
  repos: GitHubRepoEntry[];
}

/**
 * Backs the repo-picker modal opened from the chat page's "Analyze a GitHub
 * repository" suggestion card. Both endpoints always resolve with
 * `available: false` rather than erroring when GitHub isn't reachable/
 * configured - callers should check `.available` rather than relying on the
 * observable's error branch for the "not configured" / "rate limited" cases.
 */
@Injectable({
  providedIn: 'root',
})
export class GitHubService {
  private readonly apiUrl = `${API_V1_BASE}/github`;

  constructor(private http: HttpClient) {}

  /** The server-configured GITHUB_TOKEN's own repositories. */
  listMyRepos(page = 1, perPage = 30): Observable<GitHubReposResponse> {
    const params = new HttpParams().set('page', page).set('per_page', perPage);
    return this.http.get<GitHubReposResponse>(`${this.apiUrl}/repos`, { params });
  }

  /** Public GitHub repo search (works without a configured token). */
  searchPublicRepos(query: string, page = 1, perPage = 10): Observable<GitHubReposResponse> {
    const params = new HttpParams().set('q', query).set('page', page).set('per_page', perPage);
    return this.http.get<GitHubReposResponse>(`${this.apiUrl}/search`, { params });
  }
}
