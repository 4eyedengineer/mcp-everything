import { Injectable } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Observable, throwError, interval } from 'rxjs';
import { catchError, map, switchMap, takeWhile, startWith } from 'rxjs/operators';

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
 * Server status response from polling endpoint
 */
export interface ServerStatusResponse {
  serverId: string;
  status: HostedServerStatus;
  message: string;
  replicas: number;
  readyReplicas: number;
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

@Injectable({
  providedIn: 'root'
})
export class HostingApiService {
  private readonly baseUrl = 'http://localhost:3000/api/hosting';

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

    let errorMessage = 'An unexpected error occurred';

    if (error.error instanceof ErrorEvent) {
      // Client-side error
      errorMessage = error.error.message;
    } else if (error.error?.error) {
      // Backend error with message
      errorMessage = error.error.error;
    } else if (error.error?.message) {
      // Alternative backend error format
      errorMessage = error.error.message;
    } else if (error.status === 404) {
      errorMessage = 'Server not found. It may have been deleted.';
    } else if (error.status === 429) {
      errorMessage = 'Too many requests. Please wait a moment before trying again.';
    } else if (error.status === 500) {
      errorMessage = 'Server error during operation. Please try again.';
    }

    return throwError(() => ({
      success: false,
      error: errorMessage
    }));
  }
}
