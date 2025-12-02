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
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { ChatService, ChatMessage } from '../../core/services/chat.service';
import { ConversationService, Deployment } from '../../core/services/conversation.service';
import { DeploymentService, DeploymentResponse, ValidationResponse } from '../../core/services/deployment.service';
import { SafeMarkdownPipe } from '../../shared/pipes/safe-markdown.pipe';
import { v4 as uuidv4 } from 'uuid';
import { Subscription } from 'rxjs';
import * as JSZip from 'jszip';

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
  deploymentResult?: DeploymentResponse;
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
    MatSnackBarModule,
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

  // Deployment state
  deploymentState: 'idle' | 'deploying' | 'success' | 'failed' = 'idle';
  deployingMessageIndex?: number;

  constructor(
    private chatService: ChatService,
    private conversationService: ConversationService,
    private deploymentService: DeploymentService,
    private http: HttpClient,
    private route: ActivatedRoute,
    private router: Router,
    private zone: NgZone,
    private snackBar: MatSnackBar
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
      this.conversationService.getLatestDeployment(this.conversationId!).subscribe({
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

  /**
   * Deploy generated MCP server to GitHub repository
   */
  deployToGitHub(message: ExtendedChatMessage): void {
    if (!message.generatedCode || !this.conversationId) {
      this.snackBar.open('No generated code or conversation available', 'Close', { duration: 3000 });
      return;
    }

    const messageIndex = this.messages.indexOf(message);
    this.deploymentState = 'deploying';
    this.deployingMessageIndex = messageIndex;

    this.deploymentService.deployToGitHub(this.conversationId).subscribe({
      next: (response) => {
        this.deploymentState = response.success ? 'success' : 'failed';
        message.deploymentResult = response;
        this.deployingMessageIndex = undefined;

        if (response.success) {
          this.snackBar.open('Successfully deployed to GitHub!', 'Close', { duration: 3000 });
          // Reload deployment info
          this.conversationService.getLatestDeployment(this.conversationId!).subscribe({
            next: (deployment) => {
              this.latestDeployment = deployment;
            }
          });
        } else {
          this.snackBar.open(response.error || 'Deployment failed', 'Close', { duration: 5000 });
        }
      },
      error: (error: DeploymentResponse) => {
        this.deploymentState = 'failed';
        message.deploymentResult = error;
        this.deployingMessageIndex = undefined;
        this.snackBar.open(error.error || 'Deployment failed', 'Close', { duration: 5000 });
      }
    });
  }

  /**
   * Deploy generated MCP server to GitHub Gist
   */
  deployToGist(message: ExtendedChatMessage): void {
    if (!message.generatedCode || !this.conversationId) {
      this.snackBar.open('No generated code or conversation available', 'Close', { duration: 3000 });
      return;
    }

    const messageIndex = this.messages.indexOf(message);
    this.deploymentState = 'deploying';
    this.deployingMessageIndex = messageIndex;

    this.deploymentService.deployToGist(this.conversationId).subscribe({
      next: (response) => {
        this.deploymentState = response.success ? 'success' : 'failed';
        message.deploymentResult = response;
        this.deployingMessageIndex = undefined;

        if (response.success) {
          this.snackBar.open('Successfully deployed to Gist!', 'Close', { duration: 3000 });
          // Reload deployment info
          this.conversationService.getLatestDeployment(this.conversationId!).subscribe({
            next: (deployment) => {
              this.latestDeployment = deployment;
            }
          });
        } else {
          this.snackBar.open(response.error || 'Deployment failed', 'Close', { duration: 5000 });
        }
      },
      error: (error: DeploymentResponse) => {
        this.deploymentState = 'failed';
        message.deploymentResult = error;
        this.deployingMessageIndex = undefined;
        this.snackBar.open(error.error || 'Deployment failed', 'Close', { duration: 5000 });
      }
    });
  }

  /**
   * Download generated MCP server as ZIP file
   */
  async downloadAsZip(message: ExtendedChatMessage): Promise<void> {
    if (!message.generatedCode) {
      return;
    }

    const zip = new JSZip();
    const files = message.generatedCode.supportingFiles || {};
    const mainFile = message.generatedCode.mainFile || '';
    const documentation = message.generatedCode.documentation || '';

    // Add main file (usually index.ts)
    if (mainFile) {
      zip.file('src/index.ts', mainFile);
    }

    // Add supporting files
    for (const [filename, content] of Object.entries(files)) {
      if (typeof content === 'string') {
        // Preserve file paths or put in src directory
        const filePath = filename.startsWith('src/') ? filename : `src/${filename}`;
        zip.file(filePath, content);
      }
    }

    // Add documentation as README
    if (documentation) {
      zip.file('README.md', documentation);
    }

    // Add package.json if not present
    if (!files['package.json']) {
      const packageJson = {
        name: 'mcp-server',
        version: '1.0.0',
        type: 'module',
        main: 'dist/index.js',
        scripts: {
          build: 'tsc',
          start: 'node dist/index.js'
        },
        dependencies: {
          '@modelcontextprotocol/sdk': '^1.0.0'
        },
        devDependencies: {
          typescript: '^5.0.0',
          '@types/node': '^20.0.0'
        }
      };
      zip.file('package.json', JSON.stringify(packageJson, null, 2));
    }

    // Generate and download ZIP
    const content = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(content);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'mcp-server.zip';
    link.click();
    URL.revokeObjectURL(url);

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
  isDeploying(message: ExtendedChatMessage): boolean {
    const messageIndex = this.messages.indexOf(message);
    return this.deploymentState === 'deploying' && this.deployingMessageIndex === messageIndex;
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
  revalidateDeployment(message: ExtendedChatMessage): void {
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
      error: (error) => {
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
}