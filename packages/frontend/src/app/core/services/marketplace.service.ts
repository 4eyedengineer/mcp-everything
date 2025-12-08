import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

// Types matching backend DTOs
export type McpServerCategory =
  | 'api'
  | 'database'
  | 'utility'
  | 'ai'
  | 'devtools'
  | 'communication'
  | 'storage'
  | 'analytics'
  | 'other';

export type McpServerLanguage = 'typescript' | 'python' | 'javascript';

export type SortField = 'downloads' | 'rating' | 'recent' | 'name';
export type SortOrder = 'asc' | 'desc';

export interface AuthorResponse {
  id: string;
  firstName?: string;
  lastName?: string;
  githubUsername?: string;
}

export interface McpToolResponse {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpResourceResponse {
  uri: string;
  name: string;
  description: string;
}

export interface ServerSummaryResponse {
  id: string;
  name: string;
  slug: string;
  description: string;
  category: McpServerCategory;
  tags?: string[];
  author?: AuthorResponse;
  downloadCount: number;
  rating: number;
  ratingCount: number;
  featured: boolean;
  language: McpServerLanguage;
  createdAt: Date;
}

export interface ServerResponse extends ServerSummaryResponse {
  longDescription?: string;
  visibility: 'public' | 'private' | 'unlisted';
  repositoryUrl?: string;
  gistUrl?: string;
  downloadUrl?: string;
  tools?: McpToolResponse[];
  resources?: McpResourceResponse[];
  envVars?: string[];
  viewCount: number;
  status: 'pending' | 'approved' | 'rejected' | 'archived';
  sourceConversationId?: string;
  metadata?: Record<string, unknown>;
  updatedAt: Date;
  publishedAt?: Date;
}

export interface CategoryResponse {
  key: string;
  name: string;
  description: string;
  examples: readonly string[];
  serverCount?: number;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNext: boolean;
  hasPrevious: boolean;
}

export interface SearchParams {
  query?: string;
  category?: McpServerCategory;
  tags?: string[];
  language?: McpServerLanguage;
  sortBy?: SortField;
  sortOrder?: SortOrder;
  page?: number;
  limit?: number;
  featured?: boolean;
}

export interface PublishServerRequest {
  name: string;
  description: string;
  longDescription?: string;
  category: McpServerCategory;
  tags?: string[];
  visibility: 'public' | 'private' | 'unlisted';
}

@Injectable({
  providedIn: 'root',
})
export class MarketplaceService {
  private readonly apiUrl = `${environment.apiUrl}/api/v1/marketplace`;

  constructor(private http: HttpClient) {}

  /**
   * Search and list servers with filters and pagination
   */
  search(params: SearchParams = {}): Observable<PaginatedResponse<ServerSummaryResponse>> {
    const httpParams = this.buildParams(params);
    return this.http.get<PaginatedResponse<ServerSummaryResponse>>(`${this.apiUrl}/servers`, {
      params: httpParams,
    });
  }

  /**
   * Get featured servers
   */
  getFeatured(limit = 10): Observable<ServerSummaryResponse[]> {
    return this.http.get<ServerSummaryResponse[]>(`${this.apiUrl}/servers/featured`, {
      params: { limit: limit.toString() },
    });
  }

  /**
   * Get popular servers by download count
   */
  getPopular(limit = 10): Observable<ServerSummaryResponse[]> {
    return this.http.get<ServerSummaryResponse[]>(`${this.apiUrl}/servers/popular`, {
      params: { limit: limit.toString() },
    });
  }

  /**
   * Get recently added servers
   */
  getRecent(limit = 10): Observable<ServerSummaryResponse[]> {
    return this.http.get<ServerSummaryResponse[]>(`${this.apiUrl}/servers/recent`, {
      params: { limit: limit.toString() },
    });
  }

  /**
   * Get all categories with server counts
   */
  getCategories(): Observable<CategoryResponse[]> {
    return this.http.get<CategoryResponse[]>(`${this.apiUrl}/categories`);
  }

  /**
   * Get a server by its slug
   */
  getBySlug(slug: string): Observable<ServerResponse> {
    return this.http.get<ServerResponse>(`${this.apiUrl}/servers/${slug}`);
  }

  /**
   * Record a download and increment counter
   */
  recordDownload(id: string): Observable<{ success: boolean }> {
    return this.http.post<{ success: boolean }>(`${this.apiUrl}/servers/${id}/download`, {});
  }

  /**
   * Publish a generated MCP server from a conversation to the marketplace
   */
  publishFromConversation(
    conversationId: string,
    publishData: PublishServerRequest
  ): Observable<ServerResponse> {
    return this.http.post<ServerResponse>(
      `${this.apiUrl}/servers/publish/${conversationId}`,
      publishData
    );
  }

  /**
   * Update an existing server's metadata
   */
  updateServer(
    id: string,
    updateData: Partial<PublishServerRequest>
  ): Observable<ServerResponse> {
    return this.http.patch<ServerResponse>(`${this.apiUrl}/servers/${id}`, updateData);
  }

  /**
   * Delete a server from the marketplace
   */
  deleteServer(id: string): Observable<{ success: boolean }> {
    return this.http.delete<{ success: boolean }>(`${this.apiUrl}/servers/${id}`);
  }

  /**
   * Get servers owned by the current user
   */
  getMyServers(params: SearchParams = {}): Observable<PaginatedResponse<ServerSummaryResponse>> {
    const httpParams = this.buildParams(params);
    return this.http.get<PaginatedResponse<ServerSummaryResponse>>(`${this.apiUrl}/servers/mine`, {
      params: httpParams,
    });
  }

  /**
   * Build HTTP params from search params object
   */
  private buildParams(params: SearchParams): HttpParams {
    let httpParams = new HttpParams();

    if (params.query) {
      httpParams = httpParams.set('query', params.query);
    }
    if (params.category) {
      httpParams = httpParams.set('category', params.category);
    }
    if (params.tags && params.tags.length > 0) {
      httpParams = httpParams.set('tags', params.tags.join(','));
    }
    if (params.language) {
      httpParams = httpParams.set('language', params.language);
    }
    if (params.sortBy) {
      httpParams = httpParams.set('sortBy', params.sortBy);
    }
    if (params.sortOrder) {
      httpParams = httpParams.set('sortOrder', params.sortOrder);
    }
    if (params.page) {
      httpParams = httpParams.set('page', params.page.toString());
    }
    if (params.limit) {
      httpParams = httpParams.set('limit', params.limit.toString());
    }
    if (params.featured !== undefined) {
      httpParams = httpParams.set('featured', params.featured.toString());
    }

    return httpParams;
  }
}
