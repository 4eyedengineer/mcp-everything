import { Component, EventEmitter, Input, Output, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatMenuModule, MatMenuTrigger } from '@angular/material/menu';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { Observable } from 'rxjs';
import { sidebarAnimations } from '../../animations/sidebar.animations';
import { SubscriptionService, UsageInfo } from '../../../core/services/subscription.service';
import { AuthService } from '../../../core/services/auth.service';
import { ConfirmDialogComponent, ConfirmDialogData } from '../confirm-dialog/confirm-dialog.component';
import { RenameDialogComponent, RenameDialogData } from '../rename-dialog/rename-dialog.component';

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
    RouterLink,
    MatIconModule,
    MatButtonModule,
    MatTooltipModule,
    MatMenuModule,
    MatProgressBarModule,
    MatDialogModule
  ],
  templateUrl: './conversation-sidebar.component.html',
  styleUrls: ['./conversation-sidebar.component.scss'],
  animations: sidebarAnimations
})
export class ConversationSidebarComponent implements OnInit {
  @Input() isOpen = false;
  @Input() conversations: Conversation[] = [];
  @Output() close = new EventEmitter<void>();
  @Output() newChat = new EventEmitter<void>();
  @Output() selectConversation = new EventEmitter<string>();
  @Output() deleteConversation = new EventEmitter<string>();
  @Output() renameConversation = new EventEmitter<{id: string, title: string}>();

  usage$: Observable<UsageInfo | null>;

  constructor(
    private router: Router,
    private subscriptionService: SubscriptionService,
    private authService: AuthService,
    private dialog: MatDialog
  ) {
    this.usage$ = this.subscriptionService.usage$;
  }

  ngOnInit(): void {
    // Only fetch usage once auth is actually ready - this component is part
    // of the persistent app shell and mounts before login resolves, so
    // firing this unconditionally on every load hit the API pre-auth and
    // logged a 401 to the backend error_log on every page load.
    this.authService.isAuthenticated$.subscribe(isAuthenticated => {
      if (isAuthenticated) {
        this.subscriptionService.getUsage().subscribe();
      }
    });
  }

  isUnlimited(limit: number): boolean {
    return this.subscriptionService.isUnlimited(limit);
  }

  onClose(): void {
    this.close.emit();
  }

  // NOTE: these deliberately do NOT also emit `close` - the parent
  // (AppComponent) decides whether to close the sidebar after a
  // new-chat/select action based on viewport width (see
  // closeSidebarOnMobile there). Emitting close here as well previously
  // force-closed the sidebar unconditionally, even on desktop where it's
  // meant to stay open as a persistent panel.
  onNewChat(): void {
    this.newChat.emit();
  }

  onSelectConversation(conversationId: string): void {
    this.selectConversation.emit(conversationId);
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

  onDeleteConversation(event: Event, conversationId: string, menuTrigger: MatMenuTrigger): void {
    event.stopPropagation();
    // The stopPropagation() above (needed so this click doesn't also bubble
    // into the conversation row's own click handler) incidentally suppresses
    // MatMenu's own outside-click detection that would otherwise close the
    // menu on item selection - close it explicitly instead, so it doesn't
    // stay open behind the dialog we're about to show.
    menuTrigger.closeMenu();

    const dialogRef = this.dialog.open<ConfirmDialogComponent, ConfirmDialogData, boolean>(
      ConfirmDialogComponent,
      {
        width: '400px',
        data: {
          title: 'Delete conversation?',
          message: 'This conversation and its messages will be permanently deleted. This cannot be undone.',
          confirmLabel: 'Delete',
          destructive: true
        }
      }
    );

    dialogRef.afterClosed().subscribe(confirmed => {
      if (confirmed) {
        this.deleteConversation.emit(conversationId);
      }
    });
  }

  onRenameConversation(event: Event, conversation: Conversation, menuTrigger: MatMenuTrigger): void {
    event.stopPropagation();
    // See the comment in onDeleteConversation() re: closing the menu explicitly.
    menuTrigger.closeMenu();

    const dialogRef = this.dialog.open<RenameDialogComponent, RenameDialogData, string>(
      RenameDialogComponent,
      {
        width: '400px',
        data: {
          title: 'Rename conversation',
          label: 'Title',
          value: conversation.title
        }
      }
    );

    dialogRef.afterClosed().subscribe(newTitle => {
      if (newTitle && newTitle.trim() !== conversation.title) {
        this.renameConversation.emit({ id: conversation.id, title: newTitle.trim() });
      }
    });
  }
}
