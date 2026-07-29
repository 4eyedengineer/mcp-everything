import { Injectable, NgZone, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of, throwError } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { ConversationService, Deployment } from './conversation.service';
import { DeploymentResponse } from './deployment.service';
import { API_BASE } from '../config/api.config';

export interface ChatMessage {
  content: string;
  isUser: boolean;
  timestamp: Date;
  type?: 'user' | 'assistant' | 'progress' | 'error';
  generatedCode?: any;
  deploymentResult?: DeploymentResponse;
}

export interface ChatRequest {
  message: string;
  sessionId: string;
  conversationId?: string;
}

export interface ChatResponse {
  response: string;
  conversationId?: string;
}

export interface StreamTicketResponse {
  ticket: string;
  expiresInSeconds: number;
}

interface StreamUpdate {
  type: 'progress' | 'result' | 'complete' | 'error';
  node?: string;
  message?: string;
  data?: any;
  timestamp: Date;
}

/**
 * Single source of truth for chat/conversation state.
 *
 * Owns the message list, the active conversation id, the "waiting for
 * assistant reply" loading flag, the latest deployment info for the current
 * conversation, and the SSE connection that streams progress/result/complete
 * updates from the backend. Components should render from this service's
 * signals rather than keeping their own parallel copy of any of this state.
 */
@Injectable({
  providedIn: 'root'
})
export class ChatService {
  private readonly baseUrl = API_BASE;

  /** All messages for the currently active conversation. */
  readonly messages = signal<ChatMessage[]>([]);
  /** True while waiting for the assistant's reply to a sent message. */
  readonly isLoading = signal(false);
  /** The conversation currently being displayed, if any. */
  readonly conversationId = signal<string | undefined>(undefined);
  /** Latest deployment info for the current conversation, if any. */
  readonly latestDeployment = signal<Deployment | null>(null);

  private eventSource?: EventSource;
  private currentProgressMessage?: ChatMessage;

  constructor(
    private http: HttpClient,
    private conversationService: ConversationService,
    private zone: NgZone
  ) {}

  // ---------------------------------------------------------------------
  // Conversation / message state
  // ---------------------------------------------------------------------

  setConversationId(conversationId: string | undefined): void {
    this.conversationId.set(conversationId);
  }

  setLatestDeployment(deployment: Deployment | null): void {
    this.latestDeployment.set(deployment);
  }

  /**
   * Add a message to the current message list.
   */
  addMessage(message: ChatMessage): void {
    this.messages.update(current => [...current, message]);
  }

  /**
   * Clear all messages (does not affect conversationId/latestDeployment -
   * callers that are switching conversations entirely should also call
   * `setConversationId`/`setLatestDeployment` as needed).
   */
  clearMessages(): void {
    this.messages.set([]);
    this.currentProgressMessage = undefined;
  }

  /**
   * Get current messages.
   */
  getMessages(): ChatMessage[] {
    return this.messages();
  }

  /**
   * Load conversation history and the conversation's latest deployment info,
   * and set both as the active state.
   */
  loadConversationHistory(conversationId: string): Observable<ChatMessage[]> {
    this.conversationId.set(conversationId);
    this.latestDeployment.set(null);

    this.conversationService.getLatestDeployment(conversationId).subscribe({
      next: deployment => this.latestDeployment.set(deployment),
      error: error => console.error('Error loading deployment:', error)
    });

    return this.conversationService.getConversationMessages(conversationId).pipe(
      map(messages => {
        // Transform ConversationMessage to ChatMessage format
        const chatMessages: ChatMessage[] = messages.map(msg => ({
          content: msg.content,
          isUser: msg.role === 'user',
          timestamp: msg.timestamp,
          type: msg.role,
          generatedCode: msg.metadata?.generatedCode
        }));

        this.messages.set(chatMessages);
        return chatMessages;
      }),
      catchError(error => {
        console.error('Error loading conversation history:', error);
        this.messages.set([]);
        return of([]);
      })
    );
  }

  // ---------------------------------------------------------------------
  // Sending messages
  // ---------------------------------------------------------------------

  /**
   * Send a message to the chat API. The user's message is applied to state
   * immediately; the assistant's reply arrives asynchronously through the SSE
   * stream (see `connect`).
   */
  sendMessage(content: string, sessionId: string): Observable<ChatResponse> {
    this.addMessage({
      content,
      isUser: true,
      timestamp: new Date(),
      type: 'user'
    });
    this.isLoading.set(true);

    const request: ChatRequest = {
      message: content,
      sessionId,
      conversationId: this.conversationId()
    };

    return this.http.post<ChatResponse>(`${this.baseUrl}/chat/message`, request).pipe(
      catchError(error => {
        console.error('Error sending message:', error);
        this.isLoading.set(false);
        this.addMessage({
          content: 'Failed to send message. Please try again.',
          isUser: false,
          timestamp: new Date(),
          type: 'error'
        });
        return throwError(() => error);
      })
    );
  }

  // ---------------------------------------------------------------------
  // SSE stream
  // ---------------------------------------------------------------------

  /**
   * Open the SSE stream for the given session.
   *
   * Tickets are single-use and short-lived (60s TTL), so a fresh ticket is
   * requested each time we (re)connect - including on reconnect after an
   * error - rather than reusing a previously issued ticket.
   */
  connect(sessionId: string): void {
    this.getStreamTicket(sessionId).subscribe({
      next: ({ ticket }) => this.openEventSource(sessionId, ticket),
      error: error => {
        console.error('Failed to obtain SSE stream ticket:', error);
        // Retry after a delay
        setTimeout(() => this.connect(sessionId), 5000);
      }
    });
  }

  disconnect(): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = undefined;
    }
  }

  private getStreamTicket(sessionId: string): Observable<StreamTicketResponse> {
    return this.http.post<StreamTicketResponse>(`${this.baseUrl}/chat/stream-ticket`, { sessionId });
  }

  private getStreamUrl(sessionId: string, ticket: string): string {
    return `${this.baseUrl}/chat/stream/${sessionId}?ticket=${encodeURIComponent(ticket)}`;
  }

  private openEventSource(sessionId: string, ticket: string): void {
    this.disconnect();
    this.eventSource = new EventSource(this.getStreamUrl(sessionId, ticket));

    this.eventSource.onmessage = event => {
      this.zone.run(() => {
        try {
          const update: StreamUpdate = JSON.parse(event.data);
          this.handleStreamUpdate(update);
        } catch (error) {
          console.error('Error parsing SSE message:', error);
        }
      });
    };

    this.eventSource.onerror = error => {
      this.zone.run(() => {
        console.error('SSE connection error:', error);
        this.disconnect();
        // Tickets are single-use - fetch a fresh one before reconnecting
        setTimeout(() => this.connect(sessionId), 5000);
      });
    };

    console.log('SSE connection established for session:', sessionId);
  }

  private handleStreamUpdate(update: StreamUpdate): void {
    switch (update.type) {
      case 'progress':
        this.handleProgressUpdate(update);
        break;
      case 'result':
        this.handleResultUpdate(update);
        break;
      case 'complete':
        this.handleCompleteUpdate(update);
        break;
      case 'error':
        this.handleErrorUpdate(update);
        break;
    }
  }

  private handleProgressUpdate(update: StreamUpdate): void {
    // Update or create progress message
    if (this.currentProgressMessage) {
      this.currentProgressMessage.content = update.message || 'Processing...';
      // The message object was mutated in place; replace the array reference
      // so bindings depending on `messages()` re-evaluate.
      this.messages.update(current => [...current]);
    } else {
      this.currentProgressMessage = {
        content: update.message || 'Processing...',
        isUser: false,
        timestamp: new Date(update.timestamp),
        type: 'progress'
      };
      this.addMessage(this.currentProgressMessage);
    }
  }

  private handleResultUpdate(update: StreamUpdate): void {
    // Clear progress message
    this.currentProgressMessage = undefined;

    this.addMessage({
      content: update.message || '',
      isUser: false,
      timestamp: new Date(update.timestamp),
      type: 'assistant'
    });
  }

  private handleCompleteUpdate(update: StreamUpdate): void {
    // Clear progress message
    this.currentProgressMessage = undefined;
    this.isLoading.set(false);

    this.addMessage({
      content: update.message || 'Completed!',
      isUser: false,
      timestamp: new Date(update.timestamp),
      type: 'assistant',
      generatedCode: update.data?.generatedCode
    });

    // Store conversation ID
    if (update.data?.conversationId) {
      this.conversationId.set(update.data.conversationId);

      // Load deployment info after completion
      this.conversationService.getLatestDeployment(update.data.conversationId).subscribe({
        next: deployment => {
          this.latestDeployment.set(deployment);
          console.log('Loaded deployment after completion:', deployment);
        },
        error: error => {
          console.error('Error loading deployment:', error);
        }
      });
    }
  }

  private handleErrorUpdate(update: StreamUpdate): void {
    // Clear progress message
    this.currentProgressMessage = undefined;
    this.isLoading.set(false);

    this.addMessage({
      content: update.message || 'An error occurred',
      isUser: false,
      timestamp: new Date(update.timestamp),
      type: 'error'
    });
  }
}
