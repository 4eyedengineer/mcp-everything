import { Injectable } from '@angular/core';
import { HttpClient, HttpParams, HttpErrorResponse } from '@angular/common/http';
import { Observable, throwError } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { environment } from '../../../environments/environment';
import {
  ApiResponse,
  PaginationParams,
  SearchParams
} from '@mcp-everything/shared';

@Injectable({
  providedIn: 'root'
})
export class ApiService {
  private readonly baseUrl = environment.apiUrl;

  constructor(private http: HttpClient) {}

  /**
   * Generic GET request
   */
  get<T>(endpoint: string, params?: any): Observable<T> {
    const httpParams = this.buildParams(params);
    return this.http.get<ApiResponse<T>>(`${this.baseUrl}${endpoint}`, { params: httpParams })
      .pipe(
        map(response => this.handleResponse(response)),
        catchError(this.handleError)
      );
  }

  /**
   * Generic POST request
   */
  post<T>(endpoint: string, data: any): Observable<T> {
    return this.http.post<ApiResponse<T>>(`${this.baseUrl}${endpoint}`, data)
      .pipe(
        map(response => this.handleResponse(response)),
        catchError(this.handleError)
      );
  }

  /**
   * Generic PUT request
   */
  put<T>(endpoint: string, data: any): Observable<T> {
    return this.http.put<ApiResponse<T>>(`${this.baseUrl}${endpoint}`, data)
      .pipe(
        map(response => this.handleResponse(response)),
        catchError(this.handleError)
      );
  }

  /**
   * Generic PATCH request
   */
  patch<T>(endpoint: string, data: any): Observable<T> {
    return this.http.patch<ApiResponse<T>>(`${this.baseUrl}${endpoint}`, data)
      .pipe(
        map(response => this.handleResponse(response)),
        catchError(this.handleError)
      );
  }

  /**
   * Generic DELETE request
   */
  delete<T>(endpoint: string): Observable<T> {
    return this.http.delete<ApiResponse<T>>(`${this.baseUrl}${endpoint}`)
      .pipe(
        map(response => this.handleResponse(response)),
        catchError(this.handleError)
      );
  }

  /**
   * GET request with pagination support
   */
  getPaginated<T>(endpoint: string, params?: PaginationParams): Observable<{
    data: T[];
    meta: any;
  }> {
    const httpParams = this.buildParams(params);
    return this.http.get<ApiResponse<T[]>>(`${this.baseUrl}${endpoint}`, { params: httpParams })
      .pipe(
        map(response => ({
          data: response.data || [],
          meta: response.meta || {}
        })),
        catchError(this.handleError)
      );
  }

  /**
   * Search request with filters
   */
  search<T>(endpoint: string, params?: SearchParams): Observable<{
    data: T[];
    meta: any;
  }> {
    return this.getPaginated<T>(endpoint, params);
  }

  /**
   * Upload file
   */
  uploadFile<T>(endpoint: string, file: File, additionalData?: any): Observable<T> {
    const formData = new FormData();
    formData.append('file', file);

    if (additionalData) {
      Object.keys(additionalData).forEach(key => {
        formData.append(key, additionalData[key]);
      });
    }

    return this.http.post<ApiResponse<T>>(`${this.baseUrl}${endpoint}`, formData)
      .pipe(
        map(response => this.handleResponse(response)),
        catchError(this.handleError)
      );
  }

  /**
   * Download file
   */
  downloadFile(endpoint: string, filename?: string): Observable<Blob> {
    return this.http.get(`${this.baseUrl}${endpoint}`, {
      responseType: 'blob'
    }).pipe(
      catchError(this.handleError)
    );
  }

  /**
   * Build HTTP params from object
   */
  private buildParams(params?: any): HttpParams {
    let httpParams = new HttpParams();

    if (params) {
      Object.keys(params).forEach(key => {
        const value = params[key];
        if (value !== null && value !== undefined) {
          if (Array.isArray(value)) {
            value.forEach(item => {
              httpParams = httpParams.append(key, item.toString());
            });
          } else {
            httpParams = httpParams.set(key, value.toString());
          }
        }
      });
    }

    return httpParams;
  }

  /**
   * Handle API response
   */
  private handleResponse<T>(response: ApiResponse<T>): T {
    if (response.success && response.data !== undefined) {
      return response.data;
    }

    if (response.error) {
      throw response.error;
    }

    throw new Error('Invalid API response format');
  }

  /**
   * Handle HTTP errors
   */
  private handleError = (error: HttpErrorResponse): Observable<never> => {
    let errorMessage = 'An unexpected error occurred';

    if (error.error instanceof ErrorEvent) {
      // Client-side error
      errorMessage = error.error.message;
    } else {
      // Server-side error
      if (error.error?.message) {
        errorMessage = error.error.message;
      } else if (error.message) {
        errorMessage = error.message;
      }

      // Log error details in development
      if (!environment.production) {
        console.error('API Error:', {
          status: error.status,
          statusText: error.statusText,
          url: error.url,
          error: error.error
        });
      }
    }

    return throwError(() => ({
      message: errorMessage,
      status: error.status,
      originalError: error
    }));
  };

  /**
   * Get full API URL
   */
  getApiUrl(endpoint: string): string {
    return `${this.baseUrl}${endpoint}`;
  }

  /**
   * Check if API is healthy
   */
  healthCheck(): Observable<any> {
    return this.get('/health');
  }
}