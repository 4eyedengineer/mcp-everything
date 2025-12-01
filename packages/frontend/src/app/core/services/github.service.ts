import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';
import {
  GitHubRepository,
  GitHubAnalysisResult,
  API_ENDPOINTS
} from '@mcp-everything/shared';

export interface GitHubSearchResult {
  repositories: GitHubRepository[];
  totalCount: number;
  page: number;
  hasMore: boolean;
}

export interface RepositoryAnalysisOptions {
  includeApiEndpoints?: boolean;
  includeDependencies?: boolean;
  includeDocumentation?: boolean;
  maxFilesScan?: number;
}

@Injectable({
  providedIn: 'root'
})
export class GitHubService {
  constructor(private apiService: ApiService) {}

  /**
   * Search GitHub repositories
   */
  searchRepositories(
    query: string,
    page: number = 1,
    limit: number = 20,
    filters?: {
      language?: string;
      minStars?: number;
      sort?: 'stars' | 'updated' | 'created';
      order?: 'asc' | 'desc';
    }
  ): Observable<GitHubSearchResult> {
    const params = {
      query,
      page,
      limit,
      ...filters
    };

    return this.apiService.get<GitHubSearchResult>(
      API_ENDPOINTS.GITHUB.REPOSITORIES,
      params
    );
  }

  /**
   * Analyze a GitHub repository for MCP server generation
   */
  analyzeRepository(
    owner: string,
    repo: string,
    branch: string = 'main',
    options?: RepositoryAnalysisOptions
  ): Observable<GitHubAnalysisResult> {
    const params = {
      owner,
      repo,
      branch,
      ...options
    };

    return this.apiService.post<GitHubAnalysisResult>(
      API_ENDPOINTS.GITHUB.ANALYZE,
      params
    );
  }

  /**
   * Get repository details from GitHub URL
   */
  getRepositoryFromUrl(url: string): Observable<GitHubRepository> {
    return this.apiService.post<GitHubRepository>(
      `${API_ENDPOINTS.GITHUB.REPOSITORIES}/from-url`,
      { url }
    );
  }

  /**
   * Validate GitHub repository URL
   */
  validateRepositoryUrl(url: string): {
    isValid: boolean;
    owner?: string;
    repo?: string;
    error?: string;
  } {
    try {
      // Support various GitHub URL formats
      const patterns = [
        /^https?:\/\/github\.com\/([^\/]+)\/([^\/]+)\/?$/,
        /^https?:\/\/github\.com\/([^\/]+)\/([^\/]+)\.git$/,
        /^git@github\.com:([^\/]+)\/([^\/]+)\.git$/,
        /^([^\/]+)\/([^\/]+)$/ // Simple owner/repo format
      ];

      for (const pattern of patterns) {
        const match = url.trim().match(pattern);
        if (match) {
          const [, owner, repo] = match;

          // Remove .git suffix if present
          const cleanRepo = repo.replace(/\.git$/, '');

          return {
            isValid: true,
            owner: owner.trim(),
            repo: cleanRepo.trim()
          };
        }
      }

      return {
        isValid: false,
        error: 'Invalid GitHub repository URL format'
      };
    } catch (error) {
      return {
        isValid: false,
        error: 'Error parsing repository URL'
      };
    }
  }

  /**
   * Get user's starred repositories
   */
  getStarredRepositories(page: number = 1, limit: number = 20): Observable<GitHubSearchResult> {
    return this.apiService.get<GitHubSearchResult>(
      `${API_ENDPOINTS.GITHUB.REPOSITORIES}/starred`,
      { page, limit }
    );
  }

  /**
   * Get user's repositories
   */
  getUserRepositories(
    username?: string,
    page: number = 1,
    limit: number = 20
  ): Observable<GitHubSearchResult> {
    const params = { page, limit };
    if (username) {
      (params as any).username = username;
    }

    return this.apiService.get<GitHubSearchResult>(
      `${API_ENDPOINTS.GITHUB.REPOSITORIES}/user`,
      params
    );
  }

  /**
   * Get trending repositories
   */
  getTrendingRepositories(
    language?: string,
    since: 'daily' | 'weekly' | 'monthly' = 'weekly'
  ): Observable<GitHubRepository[]> {
    return this.apiService.get<GitHubRepository[]>(
      `${API_ENDPOINTS.GITHUB.REPOSITORIES}/trending`,
      { language, since }
    );
  }

  /**
   * Get repository languages
   */
  getRepositoryLanguages(owner: string, repo: string): Observable<Record<string, number>> {
    return this.apiService.get<Record<string, number>>(
      `${API_ENDPOINTS.GITHUB.REPOSITORIES}/${owner}/${repo}/languages`
    );
  }

  /**
   * Get repository topics/tags
   */
  getRepositoryTopics(owner: string, repo: string): Observable<string[]> {
    return this.apiService.get<string[]>(
      `${API_ENDPOINTS.GITHUB.REPOSITORIES}/${owner}/${repo}/topics`
    );
  }

  /**
   * Check repository accessibility
   */
  checkRepositoryAccess(owner: string, repo: string): Observable<{
    accessible: boolean;
    isPrivate: boolean;
    hasPermission: boolean;
    error?: string;
  }> {
    return this.apiService.get(
      `${API_ENDPOINTS.GITHUB.REPOSITORIES}/${owner}/${repo}/access`
    );
  }

  /**
   * Get supported languages for MCP generation
   */
  getSupportedLanguages(): string[] {
    return [
      'JavaScript',
      'TypeScript',
      'Python',
      'Go',
      'Java',
      'C#',
      'PHP',
      'Ruby',
      'Swift',
      'Kotlin',
      'Rust',
      'C++',
      'C',
      'Scala',
      'Clojure',
      'Elixir',
      'Haskell',
      'R',
      'MATLAB',
      'Shell'
    ];
  }

  /**
   * Estimate MCP generation complexity
   */
  estimateComplexity(analysisResult: GitHubAnalysisResult): {
    complexity: 'simple' | 'moderate' | 'complex';
    estimatedTime: number; // in minutes
    factors: string[];
  } {
    const factors: string[] = [];
    let complexity: 'simple' | 'moderate' | 'complex' = 'simple';
    let estimatedTime = 2; // base time in minutes

    // Check repository size indicators
    if (analysisResult.structure.dependencies.length > 20) {
      factors.push('Many dependencies');
      estimatedTime += 2;
    }

    if (analysisResult.apiEndpoints && analysisResult.apiEndpoints.length > 10) {
      factors.push('Multiple API endpoints');
      estimatedTime += 3;
      complexity = 'moderate';
    }

    if (analysisResult.structure.frameworks.length > 2) {
      factors.push('Multiple frameworks');
      estimatedTime += 2;
      complexity = 'moderate';
    }

    if (analysisResult.repository.language &&
        !['JavaScript', 'TypeScript', 'Python'].includes(analysisResult.repository.language)) {
      factors.push('Less common language');
      estimatedTime += 3;
      complexity = 'moderate';
    }

    // Complex indicators
    if (analysisResult.apiEndpoints && analysisResult.apiEndpoints.length > 50) {
      factors.push('Large API surface');
      estimatedTime += 5;
      complexity = 'complex';
    }

    if (analysisResult.structure.configFiles.length > 10) {
      factors.push('Complex configuration');
      estimatedTime += 2;
      complexity = 'complex';
    }

    return {
      complexity,
      estimatedTime: Math.min(estimatedTime, 15), // Cap at 15 minutes
      factors
    };
  }
}