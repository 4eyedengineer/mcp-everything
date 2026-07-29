import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterModule } from '@angular/router';
import { ViewportScroller } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { ConversationSidebarComponent } from './shared/components/conversation-sidebar/conversation-sidebar.component';
import { TopNavComponent } from './shared/components/top-nav/top-nav.component';
import { ConversationService, Conversation } from './core/services/conversation.service';
import { ChatService } from './core/services/chat.service';
import { SessionService } from './core/services/session.service';

@Component({
  selector: 'mcp-root',
  standalone: true,
  imports: [
    CommonModule,
    RouterModule,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    ConversationSidebarComponent,
    TopNavComponent
  ],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss']
})
export class AppComponent implements OnInit {
  title = 'MCP Everything';
  sidebarOpen = signal(false);
  conversations = signal<Conversation[]>([]);
  isLoadingConversations = signal(false);
  sessionId: string;

  constructor(
    private router: Router,
    private conversationService: ConversationService,
    private chatService: ChatService,
    private sessionService: SessionService,
    viewportScroller: ViewportScroller
  ) {
    // Get or create session ID
    this.sessionId = this.sessionService.getOrCreateSessionId();

    // Offset scroll-to-anchor/position-restoration by the fixed header height
    // (equivalent to the old `RouterModule.forRoot(..., { scrollOffset: [0, 64] })`).
    viewportScroller.setOffset([0, 64]);
  }

  ngOnInit(): void {
    this.loadConversations();
  }

  /**
   * Load all conversations from the backend
   */
  loadConversations(): void {
    this.isLoadingConversations.set(true);
    this.conversationService.getConversations().subscribe({
      next: (conversations) => {
        this.conversations.set(
          conversations.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
        );
        this.isLoadingConversations.set(false);
      },
      error: (error) => {
        console.error('Error loading conversations:', error);
        this.isLoadingConversations.set(false);
        // Keep empty conversations array on error
        this.conversations.set([]);
      }
    });
  }

  toggleSidebar(): void {
    this.sidebarOpen.update(open => !open);
  }

  closeSidebar(): void {
    this.sidebarOpen.set(false);
  }

  /**
   * Create a new conversation and navigate to it
   */
  onNewChat(): void {
    this.isLoadingConversations.set(true);

    this.conversationService.createConversation(this.sessionId).subscribe({
      next: (conversation) => {
        // Add new conversation to the list
        this.conversations.update(current => [conversation, ...current]);

        // Clear current chat messages
        this.chatService.clearMessages();

        // Navigate to the new conversation
        this.router.navigate(['/chat', conversation.id]);

        // Close sidebar
        this.closeSidebar();
        this.isLoadingConversations.set(false);
      },
      error: (error) => {
        console.error('Error creating new conversation:', error);
        this.isLoadingConversations.set(false);

        // Fallback: navigate to chat without conversationId (will create on first message)
        this.chatService.clearMessages();
        this.router.navigate(['/chat']);
        this.closeSidebar();
      }
    });
  }

  /**
   * Select an existing conversation and load its history
   */
  onSelectConversation(conversationId: string): void {
    // Load conversation messages
    this.chatService.loadConversationHistory(conversationId).subscribe({
      next: (messages) => {
        console.log(`Loaded ${messages.length} messages for conversation ${conversationId}`);

        // Navigate to the conversation
        this.router.navigate(['/chat', conversationId]);

        // Close sidebar
        this.closeSidebar();
      },
      error: (error) => {
        console.error('Error loading conversation:', error);

        // Still navigate even if loading fails
        this.router.navigate(['/chat', conversationId]);
        this.closeSidebar();
      }
    });
  }
}
