import { Component, OnInit, OnDestroy, effect, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatChipsModule } from '@angular/material/chips';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { ChatService, ChatMessage } from '../../core/services/chat.service';
import { ConversationService } from '../../core/services/conversation.service';
import { DeploymentService, DeploymentResponse } from '../../core/services/deployment.service';
import { HostingApiService } from '../../core/services/hosting-api.service';
import { SessionService } from '../../core/services/session.service';
import { SafeMarkdownPipe } from '../../shared/pipes/safe-markdown.pipe';
import { DeployModalComponent, DeployModalResult } from './components/deploy-modal/deploy-modal.component';
import { DeployProgressComponent, DeploymentCompleteEvent } from './components/deploy-progress/deploy-progress.component';
import { RepoPickerModalComponent, RepoPickerResult } from './components/repo-picker-modal/repo-picker-modal.component';
import { downloadServerZip } from '../../shared/utils/server-zip.util';
import { Subscription } from 'rxjs';

type DeploymentState = 'idle' | 'deploying' | 'success' | 'failed';
type CloudDeploymentState = 'idle' | 'configuring' | 'deploying' | 'success' | 'failed';

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
    MatSnackBarModule,
    MatDialogModule,
    SafeMarkdownPipe,
    DeployProgressComponent
  ],
  templateUrl: './chat.component.html',
  styleUrls: ['./chat.component.scss']
})
export class ChatComponent implements OnInit, OnDestroy {
  currentMessage = signal('');
  isLoadingHistory = signal(false);
  sessionId: string;
  private routeSubscription?: Subscription;

  // Deployment state
  deploymentState = signal<DeploymentState>('idle');
  deployingMessageIndex = signal<number | undefined>(undefined);

  // Cloud hosting state
  cloudDeploymentState = signal<CloudDeploymentState>('idle');
  cloudServerId = signal<string | undefined>(undefined);
  cloudServerName = signal<string | undefined>(undefined);
  cloudEndpointUrl = signal<string | undefined>(undefined);

  constructor(
    protected chatService: ChatService,
    private conversationService: ConversationService,
    private deploymentService: DeploymentService,
    private hostingApiService: HostingApiService,
    private sessionService: SessionService,
    private route: ActivatedRoute,
    private router: Router,
    private snackBar: MatSnackBar,
    private dialog: MatDialog
  ) {
    // Generate or restore session ID
    this.sessionId = this.sessionService.getOrCreateSessionId();

    // Keep the URL in sync with the active conversation. This fires the
    // moment ChatService learns the real conversation id - either from the
    // POST /chat/message response (as soon as the backend creates a brand
    // new conversation) or from the SSE 'complete' event - and reflects it as
    // /chat/:id via replaceUrl so the back button and refresh both keep
    // working without triggering a component reload or wiping in-flight
    // messages. Guarded so it never re-navigates when the route already
    // matches (e.g. after the route-param subscription below reacts to a
    // navigation that originated here).
    effect(() => {
      const conversationId = this.chatService.conversationId();
      const routeConversationId = this.route.snapshot.params['conversationId'];
      if (conversationId && conversationId !== routeConversationId) {
        this.router.navigate(['/chat', conversationId], { replaceUrl: true });
      }
    });
  }

  ngOnInit(): void {
    this.chatService.connect(this.sessionId);

    // Subscribe to route params to get conversationId
    this.routeSubscription = this.route.params.subscribe(params => {
      const conversationId = params['conversationId'];
      if (conversationId && conversationId !== this.chatService.conversationId()) {
        this.loadConversationHistory(conversationId);
      } else if (!conversationId) {
        // No conversationId in route - clear messages for new conversation
        this.chatService.setConversationId(undefined);
        this.chatService.clearMessages();
      }
    });
  }

  ngOnDestroy(): void {
    this.chatService.disconnect();
    this.routeSubscription?.unsubscribe();
  }

  /**
   * Load conversation history (and latest deployment info) from the backend.
   */
  private loadConversationHistory(conversationId: string): void {
    this.isLoadingHistory.set(true);

    this.chatService.loadConversationHistory(conversationId).subscribe({
      next: messages => {
        this.isLoadingHistory.set(false);
        console.log(`Loaded ${messages.length} messages for conversation ${conversationId}`);
      },
      error: error => {
        console.error('Error loading conversation history:', error);
        this.isLoadingHistory.set(false);

        // The conversationId in the URL doesn't correspond to a real
        // conversation (e.g. a bad/stale UUID). Rather than silently
        // leaving the bogus URL in place while showing the normal empty
        // new-chat screen, bounce back to /chat and let the user know why.
        this.router.navigate(['/chat'], { replaceUrl: true });
        this.snackBar.open('Conversation not found', 'Close', { duration: 4000 });
      }
    });
  }

  sendMessage(): void {
    const text = this.currentMessage().trim();
    if (!text || this.chatService.isLoading()) {
      return;
    }

    this.currentMessage.set('');
    this.dispatchMessage(text);
  }

  /**
   * Re-send a message whose original send failed. Discards the failed user
   * bubble first so retrying doesn't leave a duplicate/stale copy behind.
   */
  retryMessage(message: ChatMessage): void {
    if (this.chatService.isLoading()) {
      return;
    }
    const text = message.content;
    this.chatService.removeMessage(message);
    this.dispatchMessage(text);
  }

  private dispatchMessage(text: string): void {
    this.chatService.sendMessage(text, this.sessionId).subscribe({
      next: response => console.log('Message sent successfully', response),
      error: () => {
        // Restore the draft so the user's text isn't lost on failure. The
        // failed user bubble itself is marked (with a retry affordance in
        // the template) and the placeholder progress bubble is cleaned up
        // by ChatService.
        this.currentMessage.set(text);
      }
    });
  }

  /**
   * Deploy generated MCP server to GitHub repository
   */
  deployToGitHub(message: ChatMessage): void {
    const conversationId = this.chatService.conversationId();
    if (!message.generatedCode || !conversationId) {
      this.snackBar.open('No generated code or conversation available', 'Close', { duration: 3000 });
      return;
    }

    const messageIndex = this.chatService.messages().indexOf(message);
    this.deploymentState.set('deploying');
    this.deployingMessageIndex.set(messageIndex);

    this.deploymentService.deployToGitHub(conversationId).subscribe({
      next: (response) => {
        this.deploymentState.set(response.success ? 'success' : 'failed');
        message.deploymentResult = response;
        this.deployingMessageIndex.set(undefined);

        if (response.success) {
          this.snackBar.open('Successfully deployed to GitHub!', 'Close', { duration: 3000 });
          // Reload deployment info
          this.conversationService.getLatestDeployment(conversationId).subscribe({
            next: (deployment) => {
              this.chatService.setLatestDeployment(deployment);
            }
          });
        }
        // No toast on failure - the per-message deployment-error-card below
        // already shows this same error, contextually, with retry actions.
        // A toast here duplicated it a third time alongside the (now-removed)
        // global banner.
      },
      error: (error: DeploymentResponse) => {
        this.deploymentState.set('failed');
        message.deploymentResult = error;
        this.deployingMessageIndex.set(undefined);
      }
    });
  }

  /**
   * Deploy generated MCP server to GitHub Gist
   */
  deployToGist(message: ChatMessage): void {
    const conversationId = this.chatService.conversationId();
    if (!message.generatedCode || !conversationId) {
      this.snackBar.open('No generated code or conversation available', 'Close', { duration: 3000 });
      return;
    }

    const messageIndex = this.chatService.messages().indexOf(message);
    this.deploymentState.set('deploying');
    this.deployingMessageIndex.set(messageIndex);

    this.deploymentService.deployToGist(conversationId).subscribe({
      next: (response) => {
        this.deploymentState.set(response.success ? 'success' : 'failed');
        message.deploymentResult = response;
        this.deployingMessageIndex.set(undefined);

        if (response.success) {
          this.snackBar.open('Successfully deployed to Gist!', 'Close', { duration: 3000 });
          // Reload deployment info
          this.conversationService.getLatestDeployment(conversationId).subscribe({
            next: (deployment) => {
              this.chatService.setLatestDeployment(deployment);
            }
          });
        }
        // No toast on failure - see the comment in deployToGitHub() above.
      },
      error: (error: DeploymentResponse) => {
        this.deploymentState.set('failed');
        message.deploymentResult = error;
        this.deployingMessageIndex.set(undefined);
      }
    });
  }

  /**
   * Download generated MCP server as ZIP file. Delegates to the shared
   * server-zip util (also used by the My Servers page) so root-level files
   * like Dockerfile/.dockerignore land at the zip root instead of being
   * force-nested under src/, which broke `docker build .` on the extracted
   * zip.
   */
  async downloadAsZip(message: ChatMessage): Promise<void> {
    if (!message.generatedCode) {
      return;
    }

    await downloadServerZip(message.generatedCode);
    this.snackBar.open('ZIP file downloaded', 'Close', { duration: 2000 });
  }

  /**
   * Copy text to clipboard
   */
  copyToClipboard(text: string): void {
    navigator.clipboard.writeText(text).then(() => {
      this.snackBar.open('Copied to clipboard!', 'Close', { duration: 2000 });
    }).catch(() => {
      this.snackBar.open('Failed to copy', 'Close', { duration: 2000 });
    });
  }

  /**
   * Check if a specific message is currently deploying
   */
  isDeploying(message: ChatMessage): boolean {
    const messageIndex = this.chatService.messages().indexOf(message);
    return this.deploymentState() === 'deploying' && this.deployingMessageIndex() === messageIndex;
  }

  clearSession(): void {
    this.sessionService.clearSessionId();
    this.sessionId = this.sessionService.getOrCreateSessionId();
    this.chatService.setConversationId(undefined);
    this.chatService.setLatestDeployment(null);
    this.chatService.clearMessages();
    this.chatService.disconnect();
    this.chatService.connect(this.sessionId);

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
    this.currentMessage.set(suggestion);
    this.sendMessage();
  }

  /**
   * Open the repo-picker modal from the "Analyze a GitHub repository"
   * suggestion card, instead of silently auto-sending a hardcoded repo.
   * On selection (search result, "your repos" entry, or a pasted URL),
   * sends the same message the pipeline already expects.
   */
  openRepoPickerModal(): void {
    const dialogRef = this.dialog.open(RepoPickerModalComponent, {
      width: '560px',
      panelClass: 'repo-picker-modal-panel'
    });

    dialogRef.afterClosed().subscribe((result: RepoPickerResult | undefined) => {
      if (result?.repoUrl) {
        this.useSuggestion(`Generate an MCP server from ${result.repoUrl}`);
      }
    });
  }

  /**
   * Get CSS class for validation status badge
   */
  getValidationStatusClass(status?: string): string {
    switch (status) {
      case 'passed': return 'validation-passed';
      case 'failed': return 'validation-failed';
      case 'running': return 'validation-running';
      case 'skipped': return 'validation-skipped';
      default: return 'validation-pending';
    }
  }

  /**
   * Get icon for validation status
   */
  getValidationIcon(status?: string): string {
    switch (status) {
      case 'passed': return 'check_circle';
      case 'failed': return 'error';
      case 'running': return 'sync';
      case 'skipped': return 'skip_next';
      default: return 'schedule';
    }
  }

  /**
   * Get label for validation status
   */
  getValidationLabel(status?: string): string {
    switch (status) {
      case 'passed': return 'Validated';
      case 'failed': return 'Validation Failed';
      case 'running': return 'Validating...';
      case 'skipped': return 'Skipped';
      default: return 'Pending Validation';
    }
  }

  /**
   * Re-validate a deployment
   */
  revalidateDeployment(message: ChatMessage): void {
    if (!message.deploymentResult?.deploymentId) {
      this.snackBar.open('No deployment to validate', 'Close', { duration: 3000 });
      return;
    }

    // Update status to running
    if (message.deploymentResult) {
      message.deploymentResult.validationStatus = 'running';
    }

    this.deploymentService.validateDeployment(message.deploymentResult.deploymentId, true).subscribe({
      next: (response) => {
        if (message.deploymentResult) {
          message.deploymentResult.validationStatus = response.validationStatus;
          message.deploymentResult.toolsPassedCount = response.toolsPassedCount;
          message.deploymentResult.toolsTestedCount = response.toolsTestedCount;
        }

        if (response.success) {
          this.snackBar.open('Validation passed!', 'Close', { duration: 3000 });
        } else {
          this.snackBar.open(`Validation failed: ${response.message}`, 'Close', { duration: 5000 });
        }
      },
      error: () => {
        if (message.deploymentResult) {
          message.deploymentResult.validationStatus = 'failed';
        }
        this.snackBar.open('Validation error', 'Close', { duration: 3000 });
      }
    });
  }

  autoResize(event: Event): void {
    const textarea = event.target as HTMLTextAreaElement;
    textarea.style.height = 'auto';
    const newHeight = Math.min(textarea.scrollHeight, 200);
    textarea.style.height = newHeight + 'px';
  }

  /**
   * Open the Host on Cloud modal
   */
  openHostOnCloudModal(message: ChatMessage): void {
    const conversationId = this.chatService.conversationId();
    const latestDeployment = this.chatService.latestDeployment();
    if (!conversationId || !latestDeployment) {
      this.snackBar.open('No deployment available for hosting', 'Close', { duration: 3000 });
      return;
    }

    const dialogRef = this.dialog.open(DeployModalComponent, {
      width: '500px',
      panelClass: 'deploy-modal-panel',
      data: {
        conversationId,
        serverName: latestDeployment.serverName || 'My MCP Server',
        description: latestDeployment.description || '',
        tools: latestDeployment.tools || [],
        envVars: latestDeployment.envVars || []
      }
    });

    dialogRef.afterClosed().subscribe((result: DeployModalResult | undefined) => {
      if (result?.success && result.serverId) {
        this.cloudDeploymentState.set('deploying');
        this.cloudServerId.set(result.serverId);
        this.cloudServerName.set(this.chatService.latestDeployment()?.serverName || 'MCP Server');
        this.snackBar.open('Deployment started...', 'Close', { duration: 2000 });
      }
    });
  }

  /**
   * Handle cloud deployment completion
   */
  onCloudDeploymentComplete(event: DeploymentCompleteEvent): void {
    if (event.success) {
      this.cloudDeploymentState.set('success');
      this.cloudEndpointUrl.set(event.endpointUrl);
      this.snackBar.open('Successfully deployed to cloud!', 'Close', { duration: 3000 });
    } else {
      this.cloudDeploymentState.set('failed');
      this.snackBar.open(event.error || 'Cloud deployment failed', 'Close', { duration: 5000 });
    }
  }

  /**
   * Retry cloud deployment
   */
  retryCloudDeployment(): void {
    this.cloudDeploymentState.set('idle');
    this.cloudServerId.set(undefined);
    this.cloudServerName.set(undefined);
    this.cloudEndpointUrl.set(undefined);
  }

  /**
   * Check if cloud deployment is in progress
   */
  isCloudDeploying(): boolean {
    return this.cloudDeploymentState() === 'deploying';
  }
}
