import { Component, Input, Output, EventEmitter, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { Subscription } from 'rxjs';
import {
  HostingApiService,
  HostedServerStatus,
  ServerStatusResponse
} from '../../../../core/services/hosting-api.service';
import {
  buildClaudeDesktopConfigJson,
  claudeDesktopApiKeyHint
} from '../../../../shared/utils/claude-desktop-config.util';

/**
 * Deployment step status
 */
type StepStatus = 'pending' | 'active' | 'completed' | 'error';

/**
 * Deployment step definition
 */
interface DeploymentStep {
  id: string;
  label: string;
  status: StepStatus;
}

/**
 * Result emitted when deployment completes
 */
export interface DeploymentCompleteEvent {
  success: boolean;
  serverId: string;
  endpointUrl?: string;
  error?: string;
}

@Component({
  selector: 'mcp-deploy-progress',
  standalone: true,
  imports: [
    CommonModule,
    MatCardModule,
    MatProgressSpinnerModule,
    MatButtonModule,
    MatIconModule
  ],
  templateUrl: './deploy-progress.component.html',
  styleUrls: ['./deploy-progress.component.scss']
})
export class DeployProgressComponent implements OnInit, OnDestroy {
  @Input() serverId!: string;
  @Input() serverName = 'MCP Server';
  @Input() conversationId!: string;

  @Output() deploymentComplete = new EventEmitter<DeploymentCompleteEvent>();
  @Output() retry = new EventEmitter<void>();

  /**
   * The stages a deploy actually passes through.
   *
   * 'building' and 'pushing' used to be shown here. They described the backend
   * building and pushing a per-server container image, which no longer
   * happens and cannot: the backend runs as a pod with no docker daemon.
   * Every hosted server now runs one shared runner image that fetches and
   * compiles its own source in an initContainer, so the backend's whole
   * contribution is "apply the objects" and the cluster does the rest.
   *
   * Keeping stages nothing can ever set is not cosmetic - a bar that shows
   * 'Pushing to registry' as a step which never completes reads as a hung
   * deploy. That bug already shipped here once (nothing set 'pushing' before
   * the build/push split); this removes the possibility rather than papering
   * over it. `statusOrder` below must stay in sync with this list.
   */
  steps: DeploymentStep[] = [
    { id: 'deploying', label: 'Deploying', status: 'pending' },
    { id: 'running', label: 'Server ready', status: 'pending' }
  ];

  currentStatus: HostedServerStatus = 'pending';
  statusMessage = '';
  endpointUrl?: string;
  error?: string;
  deployed = false;
  failed = false;

  private pollingSubscription?: Subscription;
  private readonly POLL_INTERVAL = 2000;

  constructor(private hostingApiService: HostingApiService) {}

  ngOnInit(): void {
    this.startPolling();
  }

  ngOnDestroy(): void {
    this.stopPolling();
  }

  /**
   * Start polling for deployment status
   */
  private startPolling(): void {
    this.pollingSubscription = this.hostingApiService
      .pollServerStatus(this.serverId, this.POLL_INTERVAL)
      .subscribe({
        next: (status: ServerStatusResponse) => {
          this.updateStatus(status);
        },
        error: (err) => {
          this.handleError(err.error || 'Failed to get deployment status');
        }
      });
  }

  /**
   * Stop polling
   */
  private stopPolling(): void {
    if (this.pollingSubscription) {
      this.pollingSubscription.unsubscribe();
      this.pollingSubscription = undefined;
    }
  }

  /**
   * Update UI based on status response
   */
  private updateStatus(status: ServerStatusResponse): void {
    this.currentStatus = status.status;
    this.statusMessage = status.message;

    // Update step statuses based on current status
    this.updateSteps(status.status);

    // Check for terminal states
    if (status.status === 'running') {
      this.deployed = true;
      this.loadEndpointUrl();
    } else if (status.status === 'failed') {
      this.failed = true;
      this.error = status.message || 'Deployment failed';
      this.deploymentComplete.emit({
        success: false,
        serverId: this.serverId,
        error: this.error
      });
    }
  }

  /**
   * The `/status` polling response (`ServerStatusResponse`) intentionally
   * does not carry `endpointUrl` - only the full server record
   * (`GET /servers/:serverId`, via `getServer`) does. Fetch that once the
   * server reaches 'running' rather than fabricating a URL. If this call
   * fails, the deployment itself still succeeded (status polling already
   * confirmed 'running'); we just honestly show no endpoint rather than
   * inventing one.
   */
  private loadEndpointUrl(): void {
    this.hostingApiService.getServer(this.serverId).subscribe({
      next: (server) => {
        this.endpointUrl = server.endpointUrl || undefined;
        this.emitComplete();
      },
      error: () => {
        this.endpointUrl = undefined;
        this.emitComplete();
      }
    });
  }

  private emitComplete(): void {
    this.deploymentComplete.emit({
      success: true,
      serverId: this.serverId,
      endpointUrl: this.endpointUrl
    });
  }

  /**
   * Update step statuses based on server status
   */
  private updateSteps(status: HostedServerStatus): void {
    // Index 0 is the implicit "queued" state, which is not a rendered step;
    // every later entry lines up 1:1 with `steps`. 'building'/'pushing' are
    // deliberately absent - see the comment on `steps`.
    const statusOrder: HostedServerStatus[] = ['pending', 'deploying', 'running'];
    const currentIndex = statusOrder.indexOf(status);

    for (let i = 0; i < this.steps.length; i++) {
      const stepStatus = statusOrder[i + 1]; // +1 because 'pending' is index 0 but not a step
      const stepIndex = statusOrder.indexOf(stepStatus);

      if (status === 'failed') {
        // Mark current step as error, previous as completed
        if (stepIndex === currentIndex) {
          this.steps[i].status = 'error';
        } else if (stepIndex < currentIndex) {
          this.steps[i].status = 'completed';
        } else {
          this.steps[i].status = 'pending';
        }
      } else if (stepIndex < currentIndex) {
        this.steps[i].status = 'completed';
      } else if (stepIndex === currentIndex) {
        this.steps[i].status = status === 'running' ? 'completed' : 'active';
      } else {
        this.steps[i].status = 'pending';
      }
    }
  }

  /**
   * Handle polling error
   */
  private handleError(message: string): void {
    this.failed = true;
    this.error = message;
    this.stopPolling();

    // Mark current step as error
    for (const step of this.steps) {
      if (step.status === 'active') {
        step.status = 'error';
        break;
      }
    }

    this.deploymentComplete.emit({
      success: false,
      serverId: this.serverId,
      error: message
    });
  }

  /**
   * Get step icon based on status
   */
  getStepIcon(step: DeploymentStep): string {
    switch (step.status) {
      case 'completed':
        return 'check_circle';
      case 'active':
        return 'pending';
      case 'error':
        return 'error';
      default:
        return 'radio_button_unchecked';
    }
  }

  /**
   * Get Claude Desktop configuration snippet. Claude Desktop can only launch
   * local stdio processes, so a hosted server is reached through the local
   * `mcp-connect` proxy (see claude-desktop-config.util.ts) - this does not
   * depend on `endpointUrl` at all, only on `serverId`.
   *
   * The snippet now carries an API key placeholder, because hosted servers sit
   * behind the authenticating MCP gateway; see `claudeDesktopApiKeyHint`, which
   * must be shown alongside it.
   */
  get claudeDesktopConfig(): string {
    return buildClaudeDesktopConfigJson(this.serverName, this.serverId);
  }

  /** Instruction to render next to the snippet: it is not usable unedited. */
  get claudeDesktopApiKeyHint(): string {
    return claudeDesktopApiKeyHint(this.serverId);
  }

  /**
   * Copy endpoint URL to clipboard
   */
  copyEndpoint(): void {
    if (this.endpointUrl) {
      navigator.clipboard.writeText(this.endpointUrl);
    }
  }

  /**
   * Copy Claude config to clipboard
   */
  copyConfig(): void {
    navigator.clipboard.writeText(this.claudeDesktopConfig);
  }

  /**
   * Retry deployment
   */
  onRetry(): void {
    this.retry.emit();
  }
}
