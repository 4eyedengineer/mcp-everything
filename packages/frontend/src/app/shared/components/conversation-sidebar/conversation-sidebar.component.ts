import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatMenuModule } from '@angular/material/menu';
import { sidebarAnimations } from '../../animations/sidebar.animations';

interface Conversation {
  id: string;
  title: string;
  timestamp: Date;
  preview?: string;
}

@Component({
  selector: 'mcp-conversation-sidebar',
  standalone: true,
  imports: [
    CommonModule,
    MatIconModule,
    MatButtonModule,
    MatTooltipModule,
    MatMenuModule
  ],
  templateUrl: './conversation-sidebar.component.html',
  styleUrls: ['./conversation-sidebar.component.scss'],
  animations: sidebarAnimations
})
export class ConversationSidebarComponent {
  @Input() isOpen = false;
  @Input() conversations: Conversation[] = [];
  @Output() close = new EventEmitter<void>();
  @Output() newChat = new EventEmitter<void>();
  @Output() selectConversation = new EventEmitter<string>();
  @Output() deleteConversation = new EventEmitter<string>();
  @Output() renameConversation = new EventEmitter<{id: string, title: string}>();

  constructor(private router: Router) {}

  onClose(): void {
    this.close.emit();
  }

  onNewChat(): void {
    this.newChat.emit();
    this.close.emit();
  }

  onSelectConversation(conversationId: string): void {
    this.selectConversation.emit(conversationId);
    this.close.emit();
  }

  onSettings(): void {
    this.router.navigate(['/account']);
    this.close.emit();
  }

  getRelativeTime(timestamp: Date): string {
    const now = new Date();
    const diff = now.getTime() - new Date(timestamp).getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return new Date(timestamp).toLocaleDateString();
  }

  onDeleteConversation(event: Event, conversationId: string): void {
    event.stopPropagation();
    this.deleteConversation.emit(conversationId);
  }

  onRenameConversation(event: Event, conversation: Conversation): void {
    event.stopPropagation();
    const newTitle = prompt('Enter new title:', conversation.title);
    if (newTitle && newTitle.trim() !== conversation.title) {
      this.renameConversation.emit({ id: conversation.id, title: newTitle.trim() });
    }
  }
}
