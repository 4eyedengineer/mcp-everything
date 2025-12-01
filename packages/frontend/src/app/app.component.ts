import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterModule } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { ConversationSidebarComponent } from './shared/components/conversation-sidebar/conversation-sidebar.component';
import { TopNavComponent } from './shared/components/top-nav/top-nav.component';
import { ConversationService, Conversation } from './core/services/conversation.service';
import { ChatService } from './core/services/chat.service';
import { v4 as uuidv4 } from 'uuid';

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
  sidebarOpen = false;
  conversations: Conversation[] = [];
  isLoadingConversations = false;
  sessionId: string;

  constructor(
    private router: Router,
    private conversationService: ConversationService,
    private chatService: ChatService
  ) {
    // Get or create session ID
    this.sessionId = this.getOrCreateSessionId();
  }

  ngOnInit(): void {
    this.loadConversations();
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

  /**
   * Load all conversations from the backend
   */
  loadConversations(): void {
    this.isLoadingConversations = true;
    this.conversationService.getConversations().subscribe({
      next: (conversations) => {
        this.conversations = conversations.sort((a, b) =>
          b.timestamp.getTime() - a.timestamp.getTime()
        );
        this.isLoadingConversations = false;
      },
      error: (error) => {
        console.error('Error loading conversations:', error);
        this.isLoadingConversations = false;
        // Keep empty conversations array on error
        this.conversations = [];
      }
    });
  }

  toggleSidebar(): void {
    this.sidebarOpen = !this.sidebarOpen;
  }

  closeSidebar(): void {
    this.sidebarOpen = false;
  }

  /**
   * Create a new conversation and navigate to it
   */
  onNewChat(): void {
    this.isLoadingConversations = true;

    this.conversationService.createConversation(this.sessionId).subscribe({
      next: (conversation) => {
        // Add new conversation to the list
        this.conversations = [conversation, ...this.conversations];

        // Clear current chat messages
        this.chatService.clearMessages();

        // Navigate to the new conversation
        this.router.navigate(['/chat', conversation.id]);

        // Close sidebar
        this.closeSidebar();
        this.isLoadingConversations = false;
      },
      error: (error) => {
        console.error('Error creating new conversation:', error);
        this.isLoadingConversations = false;

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