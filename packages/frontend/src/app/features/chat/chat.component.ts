import { Component, OnInit, OnDestroy, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute, Router } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatChipsModule } from '@angular/material/chips';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ChatService, ChatMessage } from '../../core/services/chat.service';
import { ConversationService, Deployment } from '../../core/services/conversation.service';
import { SafeMarkdownPipe } from '../../shared/pipes/safe-markdown.pipe';
import { v4 as uuidv4 } from 'uuid';
import { Subscription } from 'rxjs';

interface StreamUpdate {
  type: 'progress' | 'result' | 'complete' | 'error';
  node?: string;
  message?: string;
  data?: any;
  timestamp: Date;
}

interface ExtendedChatMessage extends ChatMessage {
  type?: 'user' | 'assistant' | 'progress' | 'error';
  generatedCode?: any;
}

@Component({
  selector: 'mcp-chat',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatCardModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressSpinnerModule,
    MatChipsModule,
    MatTooltipModule,
    SafeMarkdownPipe
  ],
  templateUrl: './chat.component.html',
  styleUrls: ['./chat.component.scss']
})
export class ChatComponent implements OnInit, OnDestroy {
  messages: ExtendedChatMessage[] = [];
  currentMessage = '';
  isLoading = false;
  isLoadingHistory = false;
  sessionId: string;
  conversationId?: string;
  latestDeployment?: Deployment | null;
  private eventSource?: EventSource;
  currentProgressMessage?: ExtendedChatMessage;
  private routeSubscription?: Subscription;
  private messagesSubscription?: Subscription;

  constructor(
    private chatService: ChatService,
    private conversationService: ConversationService,
    private http: HttpClient,
    private route: ActivatedRoute,
    private router: Router,
    private zone: NgZone
  ) {
    // Generate or restore session ID
    this.sessionId = this.getOrCreateSessionId();
  }

  ngOnInit(): void {
    this.connectToSSE();

    // Subscribe to route params to get conversationId
    this.routeSubscription = this.route.params.subscribe(params => {
      const conversationId = params['conversationId'];
      if (conversationId && conversationId !== this.conversationId) {
        this.conversationId = conversationId;
        this.loadConversationHistory(conversationId);
      } else if (!conversationId) {
        // No conversationId in route - clear messages for new conversation
        this.conversationId = undefined;
        this.messages = [];
        this.chatService.clearMessages();
      }
    });

    // Subscribe to chat service messages
    this.messagesSubscription = this.chatService.messages$.subscribe(messages => {
      if (messages.length > 0) {
        this.messages = messages as ExtendedChatMessage[];
      }
    });
  }

  ngOnDestroy(): void {
    this.disconnectFromSSE();
    this.routeSubscription?.unsubscribe();
    this.messagesSubscription?.unsubscribe();
  }

  /**
   * Load conversation history from backend
   */
  private loadConversationHistory(conversationId: string): void {
    this.isLoadingHistory = true;
    this.latestDeployment = null;

    this.chatService.loadConversationHistory(conversationId).subscribe({
      next: (messages) => {
        this.messages = messages as ExtendedChatMessage[];
        this.isLoadingHistory = false;
        console.log(`Loaded ${messages.length} messages for conversation ${conversationId}`);
      },
      error: (error) => {
        console.error('Error loading conversation history:', error);
        this.isLoadingHistory = false;
        this.messages = [];
      }
    });

    // Load deployment info
    this.conversationService.getLatestDeployment(conversationId).subscribe({
      next: (deployment) => {
        this.latestDeployment = deployment;
        console.log('Loaded deployment:', deployment);
      },
      error: (error) => {
        console.error('Error loading deployment:', error);
      }
    });
  }

  private getOrCreateSessionId(): string {
    const stored = localStorage.getItem('mcp-session-id');
    if (stored) {
      return stored;
    }
    const newId = uuidv4();
    localStorage.setItem('mcp-session-id', newId);
    return newId;
  }

  private connectToSSE(): void {
    const apiUrl = 'http://localhost:3000';
    this.eventSource = new EventSource(`${apiUrl}/api/chat/stream/${this.sessionId}`);

    this.eventSource.onmessage = (event) => {
      this.zone.run(() => {
        try {
          console.log('SSE message received:', event.data);
          const update: StreamUpdate = JSON.parse(event.data);
          console.log('Parsed SSE update:', update);
          this.handleStreamUpdate(update);
        } catch (error) {
          console.error('Error parsing SSE message:', error);
        }
      });
    };

    this.eventSource.onerror = (error) => {
      this.zone.run(() => {
        console.error('SSE connection error:', error);
        // Attempt to reconnect after 5 seconds
        setTimeout(() => {
          if (this.eventSource?.readyState === EventSource.CLOSED) {
            this.connectToSSE();
          }
        }, 5000);
      });
    };

    console.log('SSE connection established for session:', this.sessionId);
  }

  private disconnectFromSSE(): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = undefined;
    }
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
    } else {
      this.currentProgressMessage = {
        content: update.message || 'Processing...',
        isUser: false,
        timestamp: new Date(update.timestamp),
        type: 'progress'
      };
      this.messages.push(this.currentProgressMessage);
    }
  }

  private handleResultUpdate(update: StreamUpdate): void {
    // Clear progress message
    this.currentProgressMessage = undefined;

    // Add result message
    this.messages.push({
      content: update.message || '',
      isUser: false,
      timestamp: new Date(update.timestamp),
      type: 'assistant'
    });
  }

  private handleCompleteUpdate(update: StreamUpdate): void {
    // Clear progress message
    this.currentProgressMessage = undefined;
    this.isLoading = false;

    // Add completion message
    this.messages.push({
      content: update.message || 'Completed!',
      isUser: false,
      timestamp: new Date(update.timestamp),
      type: 'assistant',
      generatedCode: update.data?.generatedCode
    });

    // Store conversation ID
    if (update.data?.conversationId) {
      this.conversationId = update.data.conversationId;

      // Load deployment info after completion
      this.conversationService.getLatestDeployment(this.conversationId).subscribe({
        next: (deployment) => {
          this.latestDeployment = deployment;
          console.log('Loaded deployment after completion:', deployment);
        },
        error: (error) => {
          console.error('Error loading deployment:', error);
        }
      });
    }
  }

  private handleErrorUpdate(update: StreamUpdate): void {
    // Clear progress message
    this.currentProgressMessage = undefined;
    this.isLoading = false;

    // Add error message
    this.messages.push({
      content: update.message || 'An error occurred',
      isUser: false,
      timestamp: new Date(update.timestamp),
      type: 'error'
    });
  }

  sendMessage(): void {
    if (!this.currentMessage.trim() || this.isLoading) {
      return;
    }

    // Add user message
    const userMessage: ExtendedChatMessage = {
      content: this.currentMessage,
      isUser: true,
      timestamp: new Date(),
      type: 'user'
    };
    this.messages.push(userMessage);

    const messageToSend = this.currentMessage;
    this.currentMessage = '';
    this.isLoading = true;

    // Send to new LangGraph API
    const apiUrl = 'http://localhost:3000';
    this.http.post(`${apiUrl}/api/chat/message`, {
      message: messageToSend,
      sessionId: this.sessionId,
      conversationId: this.conversationId
    }).subscribe({
      next: (response: any) => {
        console.log('Message sent successfully', response);
        // Response will come through SSE stream
      },
      error: (error) => {
        console.error('Error sending message:', error);
        this.isLoading = false;
        this.messages.push({
          content: 'Failed to send message. Please try again.',
          isUser: false,
          timestamp: new Date(),
          type: 'error'
        });
      }
    });
  }

  downloadGeneratedCode(message: ExtendedChatMessage): void {
    if (!message.generatedCode) {
      return;
    }

    // Create a ZIP-like structure (simplified - could use JSZip library)
    const files = message.generatedCode.supportingFiles || {};
    const mainFile = message.generatedCode.mainFile || '';
    const documentation = message.generatedCode.documentation || '';

    // For now, download as JSON
    const dataStr = JSON.stringify({
      mainFile,
      supportingFiles: files,
      documentation
    }, null, 2);

    const dataUri = 'data:application/json;charset=utf-8,' + encodeURIComponent(dataStr);
    const exportFileDefaultName = 'mcp-server.json';

    const linkElement = document.createElement('a');
    linkElement.setAttribute('href', dataUri);
    linkElement.setAttribute('download', exportFileDefaultName);
    linkElement.click();
  }

  clearSession(): void {
    localStorage.removeItem('mcp-session-id');
    this.sessionId = this.getOrCreateSessionId();
    this.conversationId = undefined;
    this.latestDeployment = null;
    this.messages = [];
    this.chatService.clearMessages();
    this.disconnectFromSSE();
    this.connectToSSE();

    // Navigate to chat without conversationId
    this.router.navigate(['/chat']);
  }

  onKeyPress(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.sendMessage();
    }
  }

  getGreeting(): string {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 18) return 'Good afternoon';
    return 'Good evening';
  }

  useSuggestion(suggestion: string): void {
    this.currentMessage = suggestion;
    this.sendMessage();
  }

  autoResize(event: Event): void {
    const textarea = event.target as HTMLTextAreaElement;
    textarea.style.height = 'auto';
    const newHeight = Math.min(textarea.scrollHeight, 200);
    textarea.style.height = newHeight + 'px';
  }
}