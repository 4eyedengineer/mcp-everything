import { Component, OnInit, effect, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NavigationEnd, Router, RouterModule } from '@angular/router';
import { ViewportScroller } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { filter } from 'rxjs';
import { ConversationSidebarComponent } from './shared/components/conversation-sidebar/conversation-sidebar.component';
import { TopNavComponent } from './shared/components/top-nav/top-nav.component';
import { ConversationService, Conversation } from './core/services/conversation.service';
import { ChatService } from './core/services/chat.service';
import { SessionService } from './core/services/session.service';

/** Below this viewport width the sidebar defaults closed (mobile/tablet). */
const DESKTOP_BREAKPOINT_PX = 1024;

/** Persists the user's manual open/closed choice across sessions. */
const SIDEBAR_STORAGE_KEY = 'mcp-sidebar-open';

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
  sidebarOpen = signal(this.getInitialSidebarState());
  conversations = signal<Conversation[]>([]);
  isLoadingConversations = signal(false);
  isAuthRoute = signal(false);
  sessionId: string;

  /**
   * Whether the user's OS/browser is set to prefers-reduced-motion. Angular's
   * animations package (used by the sidebar's slide/fade triggers) doesn't
   * read this media query on its own, so it's tracked here and bound via
   * `[@.disabled]` on <mcp-conversation-sidebar> in the template - that
   * special binding disables trigger-based animations for the element it's
   * on *and all its descendants*, so it reaches the sidebar's internal
   * @slideIn/@fadeIn triggers without conversation-sidebar.component itself
   * needing to know about reduced motion.
   */
  prefersReducedMotion = signal(this.getPrefersReducedMotion());
  private readonly reducedMotionQuery = typeof window !== 'undefined' && 'matchMedia' in window
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;

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

    // Re-derive whether the app shell (top nav + sidebar) should render on
    // every navigation - /auth/* renders "bare" so the login/register cards
    // aren't surrounded by app chrome and the sidebar's (offscreen) controls
    // don't pollute the tab order ahead of the auth form.
    this.isAuthRoute.set(this.computeIsAuthRoute(router.url));
    this.router.events
      .pipe(filter((event): event is NavigationEnd => event instanceof NavigationEnd))
      .subscribe(event => {
        this.isAuthRoute.set(this.computeIsAuthRoute(event.urlAfterRedirects));
      });

    // Keep the sidebar list in sync when a conversation is created outside of
    // the "New chat" button flow - e.g. the user types straight into a blank
    // /chat and the backend creates the conversation on the first message.
    // Only refetches when the id genuinely isn't in the list yet, so
    // switching between already-known conversations doesn't cause redundant
    // requests.
    effect(() => {
      const id = this.chatService.conversationId();
      if (id && !this.conversations().some(conversation => conversation.id === id)) {
        this.loadConversations();
      }
    });

    this.reducedMotionQuery?.addEventListener('change', (e) => this.prefersReducedMotion.set(e.matches));
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
    this.sidebarOpen.update(open => {
      const next = !open;
      this.persistSidebarState(next);
      return next;
    });
  }

  /**
   * Closes the sidebar without persisting a preference - this is also called
   * automatically after selecting/creating/deleting a conversation (mainly
   * so mobile's off-canvas overlay dismisses itself), which shouldn't be
   * treated as the user manually opting to keep the sidebar closed forever.
   * Explicit opens/closes via the hamburger toggle are persisted instead.
   */
  closeSidebar(): void {
    this.sidebarOpen.set(false);
  }

  /**
   * The sidebar's default state: the user's explicit last choice if they've
   * ever toggled it, otherwise open on desktop widths and closed on
   * mobile/tablet (where it renders as an off-canvas overlay).
   */
  private getInitialSidebarState(): boolean {
    const stored = this.readStoredSidebarState();
    if (stored !== null) {
      return stored;
    }
    return typeof window !== 'undefined' && window.innerWidth >= DESKTOP_BREAKPOINT_PX;
  }

  private readStoredSidebarState(): boolean | null {
    try {
      const stored = localStorage.getItem(SIDEBAR_STORAGE_KEY);
      if (stored === 'true') return true;
      if (stored === 'false') return false;
    } catch {
      // localStorage may be unavailable (SSR, privacy mode) - ignore.
    }
    return null;
  }

  private persistSidebarState(open: boolean): void {
    try {
      localStorage.setItem(SIDEBAR_STORAGE_KEY, String(open));
    } catch {
      // localStorage may be unavailable (SSR, privacy mode) - ignore.
    }
  }

  private computeIsAuthRoute(url: string): boolean {
    return url.startsWith('/auth');
  }

  private getPrefersReducedMotion(): boolean {
    return typeof window !== 'undefined' && 'matchMedia' in window
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
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
   * Delete a conversation and remove it from the sidebar. If it's the one
   * currently open, fall back to a blank /chat rather than leaving the page
   * pointed at a conversation that no longer exists.
   */
  onDeleteConversation(conversationId: string): void {
    this.conversationService.deleteConversation(conversationId).subscribe({
      next: () => {
        this.conversations.update(current => current.filter(c => c.id !== conversationId));

        if (this.chatService.conversationId() === conversationId) {
          this.chatService.setConversationId(undefined);
          this.chatService.setLatestDeployment(null);
          this.chatService.clearMessages();
          this.router.navigate(['/chat']);
        }
      },
      error: (error) => {
        console.error('Error deleting conversation:', error);
      }
    });
  }

  /**
   * Rename a conversation's title.
   */
  onRenameConversation(event: { id: string; title: string }): void {
    this.conversationService.updateConversationTitle(event.id, event.title).subscribe({
      next: (updated) => {
        this.conversations.update(current =>
          current.map(c => (c.id === event.id ? { ...c, title: updated.title } : c))
        );
      },
      error: (error) => {
        console.error('Error renaming conversation:', error);
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
