import { Injectable } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Observable, catchError, map, throwError } from 'rxjs';
import { API_V1_BASE } from '../config/api.config';
import { parseHttpError } from '../../shared/utils/http-error.util';

/** A single API key as returned by the list endpoint - never includes the plaintext key. */
export interface ApiKeySummary {
  id: string;
  name: string;
  keyPrefix: string;
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

/** Response from creating a key - the only time the full plaintext key is ever available. */
export interface CreatedApiKey {
  id: string;
  name: string;
  key: string;
  keyPrefix: string;
  createdAt: string;
}

@Injectable({
  providedIn: 'root',
})
export class ApiKeyService {
  private readonly baseUrl = `${API_V1_BASE}/api-keys`;

  constructor(private http: HttpClient) {}

  list(): Observable<ApiKeySummary[]> {
    return this.http.get<{ apiKeys: ApiKeySummary[] }>(this.baseUrl).pipe(
      map((res) => res.apiKeys),
      catchError((error: HttpErrorResponse) => throwError(() => new Error(parseHttpError(error))))
    );
  }

  create(name: string): Observable<CreatedApiKey> {
    return this.http.post<{ apiKey: CreatedApiKey }>(this.baseUrl, { name }).pipe(
      map((res) => res.apiKey),
      catchError((error: HttpErrorResponse) => throwError(() => new Error(parseHttpError(error))))
    );
  }

  revoke(id: string): Observable<{ success: boolean }> {
    return this.http
      .delete<{ success: boolean }>(`${this.baseUrl}/${id}`)
      .pipe(catchError((error: HttpErrorResponse) => throwError(() => new Error(parseHttpError(error)))));
  }
}
