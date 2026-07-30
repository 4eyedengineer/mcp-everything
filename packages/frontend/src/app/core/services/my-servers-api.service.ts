import { Injectable } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { API_V1_BASE } from '../config/api.config';
import { parseHttpError } from '../../shared/utils/http-error.util';

export type MyServerStatus = 'generated' | 'deployed' | 'hosted';

export interface MyServerDeploymentInfo {
  type: 'gist' | 'repo' | 'none';
  url?: string;
  deployedAt?: Date;
}

export interface MyServerHostedInfo {
  serverId: string;
  endpointUrl: string;
  status: string;
}

export interface MyServerEntry {
  conversationId: string;
  serverName: string;
  description?: string;
  toolCount: number;
  createdAt: Date;
  status: MyServerStatus;
  deployment?: MyServerDeploymentInfo;
  hosted?: MyServerHostedInfo;
}

/**
 * Every server the current user has generated, tagged with its position on
 * the GENERATED -> DEPLOYED -> HOSTED lifecycle ladder. Backs the "My
 * Servers" page - previously that page only listed HOSTED servers (via
 * HostingApiService), so a user who generated (but never deployed/hosted) a
 * server saw a blank page and thought their work had vanished.
 */
@Injectable({
  providedIn: 'root'
})
export class MyServersApiService {
  private readonly baseUrl = `${API_V1_BASE}/my-servers`;

  constructor(private http: HttpClient) {}

  getMyServers(): Observable<MyServerEntry[]> {
    return this.http.get<{ servers: MyServerEntry[] }>(this.baseUrl).pipe(
      map((response) =>
        response.servers.map((s) => ({
          ...s,
          createdAt: new Date(s.createdAt),
          deployment: s.deployment
            ? {
                ...s.deployment,
                deployedAt: s.deployment.deployedAt ? new Date(s.deployment.deployedAt) : undefined
              }
            : undefined
        }))
      ),
      catchError((error: HttpErrorResponse) => {
        console.error('Failed to get my servers:', parseHttpError(error));
        return of([]);
      })
    );
  }
}
