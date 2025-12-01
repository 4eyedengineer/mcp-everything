import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, BehaviorSubject, of } from 'rxjs';
import { map, catchError } from 'rxjs/operators';
import { ConversationService, ConversationMessage } from './conversation.service';

export interface ChatMessage {
  content: string;
  isUser: boolean;
  timestamp: Date;
  type?: 'user' | 'assistant' | 'progress' | 'error';
  generatedCode?: any;
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

@Injectable({
  providedIn: 'root'
})
export class ChatService {
  private readonly baseUrl = 'http://localhost:3000/api';
  private messagesSubject = new BehaviorSubject<ChatMessage[]>([]);
  public messages$ = this.messagesSubject.asObservable();

  constructor(
    private http: HttpClient,
    private conversationService: ConversationService
  ) {}

  /**
   * Send a message to the chat API
   */
  sendMessage(message: string, sessionId: string, conversationId?: string): Observable<ChatResponse> {
    const request: ChatRequest = {
      message,
      sessionId,
      conversationId
    };
    return this.http.post<ChatResponse>(`${this.baseUrl}/chat/message`, request);
  }

  /**
   * Load conversation history and set it as current messages
   */
  loadConversationHistory(conversationId: string): Observable<ChatMessage[]> {
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

        // Update the messages subject
        this.messagesSubject.next(chatMessages);
        return chatMessages;
      }),
      catchError(error => {
        console.error('Error loading conversation history:', error);
        return of([]);
      })
    );
  }

  /**
   * Add a message to the current message list
   */
  addMessage(message: ChatMessage): void {
    const currentMessages = this.messagesSubject.value;
    this.messagesSubject.next([...currentMessages, message]);
  }

  /**
   * Clear all messages
   */
  clearMessages(): void {
    this.messagesSubject.next([]);
  }

  /**
   * Get current messages
   */
  getMessages(): ChatMessage[] {
    return this.messagesSubject.value;
  }
}