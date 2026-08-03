import { Injectable } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Observable, throwError, interval } from 'rxjs';
import { catchError, map, switchMap, takeWhile, startWith } from 'rxjs/operators';
import { API_BASE } from '../config/api.config';
import { parseHttpError } from '../../shared/utils/http-error.util';

/**
 * Status values for hosted servers
 */
export type HostedServerStatus =
  | 'pending'
  | 'building'
  | 'pushing'
  | 'deploying'
  | 'running'
  | 'stopped'
  | 'failed'
  | 'deleted';

/**
 * Request body for deploying to cloud
 */
export interface DeployToCloudRequest {
  serverName?: string;
  description?: string;
  envVars?: Record<string, string>;
}

/**
 * Response from deploy to cloud endpoint
 */
export interface DeployToCloudResponse {
  success: boolean;
  serverId?: string;
  endpointUrl?: string;
  status?: HostedServerStatus;
  error?: string;
}

/**
 * What the user asked for, as opposed to what the cluster is doing.
 */
export type HostedServerDesiredState = 'running' | 'stopped' | 'deleted';

/**
 * What the cluster actually reports, written only by the backend's
 * reconciler. `status` above remains the value this UI renders; this is the
 * finer-grained truth behind it.
 */
export type HostedServerObservedStatus =
  | 'running'
  | 'progressing'
  | 'stopped'
  | 'degraded'
  | 'failed'
  | 'missing'
  | 'unknown';

/**
 * Server status response from polling endpoint.
 *
 * `replicas`/`readyReplicas` are now REAL counts observed from the Kubernetes
 * Deployment. They used to be derived from `status` on the backend
 * (`status === 'running' ? 1 : 0`), so they could never disagree with it.
 * They are 0 until the reconciler's first pass over a freshly deployed server.
 */
export interface ServerStatusResponse {
  serverId: string;
  status: HostedServerStatus;
  message: string;
  replicas: number;
  readyReplicas: number;
  /** Optional: older backends do not return these. */
  desiredState?: HostedServerDesiredState;
  observedStatus?: HostedServerObservedStatus | null;
  /** When the cluster was last observed; bounded by the reconciler interval. */
  observedAt?: Date | null;
  lastUpdated: Date;
}

/**
 * Tool definition for hosted server
 */
export interface HostedServerTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Full hosted server details
 */
export interface HostedServer {
  id: string;
  serverId: string;
  serverName: string;
  description?: string;
  endpointUrl: string;
  status: HostedServerStatus;
  statusMessage?: string;
  tools: HostedServerTool[];
  requestCount: number;
  lastRequestAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  deployedAt?: Date;
}

/**
 * Paginated server list response
 */
export interface ServerListResponse {
  servers: HostedServer[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

/**
 * Metadata for a hosted server's API key. Never contains the secret - the
 * backend only ever returns the plaintext key once, at creation
 * (see {@link CreatedHostedServerApiKey}).
 */
export interface HostedServerApiKey {
  id: string;
  label: string;
  /** Non-secret leading chars, e.g. `mcps_A1b2c3`. */
  keyPrefix: string;
  /** Last 4 chars of the key, for disambiguation in a list. */
  lastFour: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  /** Derived by the backend: not revoked and not past its expiry. */
  active: boolean;
}

/** Request body for creating a hosted-server API key. */
export interface CreateHostedServerApiKeyRequest {
  label: string;
  /** Optional lifetime in days. Omit for a key that never expires. */
  expiresInDays?: number;
}

/**
 * Response from creating a hosted-server API key - the ONLY response that
 * ever carries the plaintext `key`. It cannot be retrieved again afterwards.
 */
export interface CreatedHostedServerApiKey {
  key: string;
  apiKey: HostedServerApiKey;
  warning: {
    shownOnce: string;
    usage: string;
  };
}

@Injectable({
  providedIn: 'root'
})
export class HostingApiService {
  private readonly baseUrl = `${API_BASE}/hosting`;

  constructor(private http: HttpClient) {}

  /**
   * Deploy a generated MCP server to the cloud
   */
  deployToCloud(
    conversationId: string,
    data: DeployToCloudRequest
  ): Observable<DeployToCloudResponse> {
    return this.http
      .post<DeployToCloudResponse>(`${this.baseUrl}/deploy/${conversationId}`, data)
      .pipe(catchError((error) => this.handleError(error, 'deployToCloud')));
  }

  /**
   * Get the current status of a hosted server
   */
  getServerStatus(serverId: string): Observable<ServerStatusResponse> {
    return this.http
      .get<ServerStatusResponse>(`${this.baseUrl}/servers/${serverId}/status`)
      .pipe(catchError((error) => this.handleError(error, 'getServerStatus')));
  }

  /**
   * Poll server status at a regular interval until it reaches a terminal state
   * @param serverId The server ID to poll
   * @param intervalMs Polling interval in milliseconds (default: 2000)
   * @returns Observable that emits status updates and completes when terminal state reached
   */
  pollServerStatus(
    serverId: string,
    intervalMs: number = 2000
  ): Observable<ServerStatusResponse> {
    const terminalStates: HostedServerStatus[] = ['running', 'failed', 'deleted', 'stopped'];

    return interval(intervalMs).pipe(
      startWith(0),
      switchMap(() => this.getServerStatus(serverId)),
      takeWhile((status) => !terminalStates.includes(status.status), true)
    );
  }

  /**
   * Get details of a specific hosted server
   */
  getServer(serverId: string): Observable<HostedServer> {
    return this.http
      .get<HostedServer>(`${this.baseUrl}/servers/${serverId}`)
      .pipe(catchError((error) => this.handleError(error, 'getServer')));
  }

  /**
   * List all hosted servers with optional pagination
   */
  listServers(
    page: number = 1,
    limit: number = 20,
    status?: HostedServerStatus
  ): Observable<ServerListResponse> {
    const params: Record<string, string> = {
      page: page.toString(),
      limit: limit.toString()
    };
    if (status) {
      params['status'] = status;
    }

    return this.http
      .get<ServerListResponse>(`${this.baseUrl}/servers`, { params })
      .pipe(catchError((error) => this.handleError(error, 'listServers')));
  }

  /**
   * Stop a running server
   */
  stopServer(serverId: string): Observable<{ success: boolean; message: string }> {
    return this.http
      .post<{ success: boolean; message: string }>(
        `${this.baseUrl}/servers/${serverId}/stop`,
        {}
      )
      .pipe(catchError((error) => this.handleError(error, 'stopServer')));
  }

  /**
   * Start a stopped server
   */
  startServer(serverId: string): Observable<{ success: boolean; message: string }> {
    return this.http
      .post<{ success: boolean; message: string }>(
        `${this.baseUrl}/servers/${serverId}/start`,
        {}
      )
      .pipe(catchError((error) => this.handleError(error, 'startServer')));
  }

  /**
   * Delete a hosted server
   */
  deleteServer(serverId: string): Observable<{ success: boolean; message: string }> {
    return this.http
      .delete<{ success: boolean; message: string }>(`${this.baseUrl}/servers/${serverId}`)
      .pipe(catchError((error) => this.handleError(error, 'deleteServer')));
  }

  /**
   * Create an API key for a hosted server the current user owns.
   * The response's `key` field is the plaintext credential and is only ever
   * returned here - it cannot be looked up again afterwards.
   */
  createServerApiKey(
    serverId: string,
    data: CreateHostedServerApiKeyRequest
  ): Observable<CreatedHostedServerApiKey> {
    return this.http
      .post<CreatedHostedServerApiKey>(`${this.baseUrl}/servers/${serverId}/keys`, data)
      .pipe(catchError((error) => this.handleError(error, 'createServerApiKey')));
  }

  /**
   * List API key metadata (active and revoked) for a hosted server. Never
   * includes the secret - the backend does not store it to return.
   */
  listServerApiKeys(serverId: string): Observable<{ apiKeys: HostedServerApiKey[] }> {
    return this.http
      .get<{ apiKeys: HostedServerApiKey[] }>(`${this.baseUrl}/servers/${serverId}/keys`)
      .pipe(catchError((error) => this.handleError(error, 'listServerApiKeys')));
  }

  /**
   * Revoke an API key on a hosted server. Takes effect on the key's next use
   * at the MCP gateway; other keys on the same server keep working.
   */
  revokeServerApiKey(
    serverId: string,
    keyId: string
  ): Observable<{ success: boolean; apiKey: HostedServerApiKey }> {
    return this.http
      .delete<{ success: boolean; apiKey: HostedServerApiKey }>(
        `${this.baseUrl}/servers/${serverId}/keys/${keyId}`
      )
      .pipe(catchError((error) => this.handleError(error, 'revokeServerApiKey')));
  }

  /**
   * Get server logs
   * @param serverId The server ID
   * @param lines Number of log lines to retrieve (default: 100)
   */
  getLogs(
    serverId: string,
    lines: number = 100
  ): Observable<{ logs: string[]; message: string }> {
    return this.http
      .get<{ logs: string[]; message: string }>(
        `${this.baseUrl}/servers/${serverId}/logs`,
        { params: { lines: lines.toString() } }
      )
      .pipe(catchError((error) => this.handleError(error, 'getLogs')));
  }

  /**
   * Handle HTTP errors
   */
  private handleError(error: HttpErrorResponse, operation: string): Observable<never> {
    console.error(`${operation} failed:`, error);

    let errorMessage: string;

    if (error.status === 404) {
      errorMessage = 'Server not found. It may have been deleted.';
    } else if (error.status === 500) {
      errorMessage = 'Server error during operation. Please try again.';
    } else {
      errorMessage = parseHttpError(error);
    }

    return throwError(() => ({
      success: false,
      error: errorMessage
    }));
  }
}
