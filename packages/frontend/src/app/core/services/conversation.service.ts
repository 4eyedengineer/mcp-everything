import { Injectable } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Observable, throwError, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { environment } from '../../../environments/environment';

export interface Conversation {
  id: string;
  title: string;
  timestamp: Date;
  preview?: string;
  sessionId?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface ConversationMessage {
  id: string;
  conversationId: string;
  content: string;
  role: 'user' | 'assistant';
  timestamp: Date;
  metadata?: any;
}

export interface CreateConversationResponse {
  conversation: Conversation;
}

/**
 * Tool definition from deployment
 */
export interface DeploymentTool {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * Environment variable definition from deployment
 */
export interface DeploymentEnvVar {
  name: string;
  required: boolean;
  description?: string;
}

export interface Deployment {
  id: string;
  conversationId: string;
  deploymentType: 'gist' | 'repo' | 'none';
  repositoryUrl?: string;
  gistUrl?: string;
  codespaceUrl?: string;
  status: 'pending' | 'success' | 'failed';
  errorMessage?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  deployedAt?: Date;
  // Server metadata for cloud hosting
  serverName?: string;
  description?: string;
  tools?: DeploymentTool[];
  envVars?: DeploymentEnvVar[];
}

@Injectable({
  providedIn: 'root'
})
export class ConversationService {
  private readonly baseUrl = `${environment.apiUrl}/api`;

  constructor(private http: HttpClient) {}

  /**
   * Get all conversations for the current user
   */
  getConversations(): Observable<Conversation[]> {
    return this.http.get<{ conversations: Conversation[] }>(`${this.baseUrl}/conversations`).pipe(
      map(response => {
        // Transform response to ensure dates are Date objects
        return response.conversations.map(conv => ({
          ...conv,
          timestamp: new Date(conv.timestamp || conv.updatedAt || conv.createdAt || Date.now()),
          createdAt: conv.createdAt ? new Date(conv.createdAt) : undefined,
          updatedAt: conv.updatedAt ? new Date(conv.updatedAt) : undefined
        }));
      }),
      catchError(this.handleError('getConversations', []))
    );
  }

  /**
   * Get a single conversation by ID
   */
  getConversation(id: string): Observable<Conversation> {
    return this.http.get<{ conversation: Conversation }>(`${this.baseUrl}/conversations/${id}`).pipe(
      map(response => ({
        ...response.conversation,
        timestamp: new Date(response.conversation.timestamp || response.conversation.updatedAt || Date.now())
      })),
      catchError(this.handleError<Conversation>('getConversation'))
    );
  }

  /**
   * Create a new conversation
   */
  createConversation(sessionId: string): Observable<Conversation> {
    return this.http.post<CreateConversationResponse>(`${this.baseUrl}/conversations`, { sessionId }).pipe(
      map(response => ({
        ...response.conversation,
        timestamp: new Date(response.conversation.timestamp || response.conversation.createdAt || Date.now())
      })),
      catchError(this.handleError<Conversation>('createConversation'))
    );
  }

  /**
   * Get messages for a specific conversation
   */
  getConversationMessages(id: string): Observable<ConversationMessage[]> {
    return this.http.get<{ messages: ConversationMessage[] }>(`${this.baseUrl}/conversations/${id}/messages`).pipe(
      map(response => {
        // Transform response to ensure dates are Date objects
        return response.messages.map(msg => ({
          ...msg,
          timestamp: new Date(msg.timestamp)
        }));
      }),
      catchError(this.handleError('getConversationMessages', []))
    );
  }

  /**
   * Delete a conversation
   */
  deleteConversation(id: string): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/conversations/${id}`).pipe(
      catchError(this.handleError<void>('deleteConversation'))
    );
  }

  /**
   * Update conversation title
   */
  updateConversationTitle(id: string, title: string): Observable<Conversation> {
    return this.http.patch<{ conversation: Conversation }>(`${this.baseUrl}/conversations/${id}`, { title }).pipe(
      map(response => ({
        ...response.conversation,
        timestamp: new Date(response.conversation.timestamp || response.conversation.updatedAt || Date.now())
      })),
      catchError(this.handleError<Conversation>('updateConversationTitle'))
    );
  }

  /**
   * Get all deployments for a conversation
   */
  getDeployments(conversationId: string): Observable<Deployment[]> {
    return this.http.get<{ deployments: Deployment[] }>(`${this.baseUrl}/conversations/${conversationId}/deployments`).pipe(
      map(response => {
        return response.deployments.map(dep => ({
          ...dep,
          createdAt: new Date(dep.createdAt),
          deployedAt: dep.deployedAt ? new Date(dep.deployedAt) : undefined
        }));
      }),
      catchError(this.handleError('getDeployments', []))
    );
  }

  /**
   * Get the latest deployment for a conversation
   */
  getLatestDeployment(conversationId: string): Observable<Deployment | null> {
    return this.http.get<{ deployment: Deployment | null }>(`${this.baseUrl}/conversations/${conversationId}/deployments/latest`).pipe(
      map(response => {
        if (!response.deployment) {
          return null;
        }
        return {
          ...response.deployment,
          createdAt: new Date(response.deployment.createdAt),
          deployedAt: response.deployment.deployedAt ? new Date(response.deployment.deployedAt) : undefined
        };
      }),
      catchError(this.handleError<Deployment | null>('getLatestDeployment', null))
    );
  }

  /**
   * Handle HTTP errors gracefully
   */
  private handleError<T>(operation = 'operation', result?: T) {
    return (error: HttpErrorResponse): Observable<T> => {
      console.error(`${operation} failed:`, error);

      // Log error details for debugging
      if (error.error instanceof ErrorEvent) {
        // Client-side error
        console.error('Client-side error:', error.error.message);
      } else {
        // Backend error
        console.error(
          `Backend returned code ${error.status}, ` +
          `body was: ${JSON.stringify(error.error)}`
        );
      }

      // Return a safe fallback value
      return of(result as T);
    };
  }
}
