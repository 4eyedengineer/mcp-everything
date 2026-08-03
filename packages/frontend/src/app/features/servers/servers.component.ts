import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, Router } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { forkJoin, Subject, interval } from 'rxjs';
import { takeUntil, startWith, switchMap } from 'rxjs/operators';

import { HostingApiService, HostedServer } from '../../core/services/hosting-api.service';
import { MyServersApiService, MyServerEntry } from '../../core/services/my-servers-api.service';
import { ConversationService } from '../../core/services/conversation.service';
import { ServerManagementCardComponent } from './components/server-management-card/server-management-card.component';
import { LogsModalComponent } from './components/logs-modal/logs-modal.component';
import { ConfirmModalComponent } from './components/confirm-modal/confirm-modal.component';
import { ApiKeysModalComponent } from './components/api-keys-modal/api-keys-modal.component';
import { downloadServerZip, GeneratedServerCode } from '../../shared/utils/server-zip.util';

/**
 * A "My Servers" row: the lifecycle-ladder entry from the aggregation
 * endpoint, plus (once it reaches the 'hosted' rung) the full hosted-server
 * record needed to drive the existing management card's start/stop/logs
 * actions - the ladder endpoint intentionally only returns a thin summary
 * (serverId/endpointUrl/status), not the full HostedServer shape.
 */
interface ServerRow {
  entry: MyServerEntry;
  hostedServer?: HostedServer;
}

@Component({
  selector: 'mcp-servers',
  standalone: true,
  imports: [
    CommonModule,
    RouterModule,
    MatIconModule,
    MatButtonModule,
    MatProgressSpinnerModule,
    MatSnackBarModule,
    ServerManagementCardComponent,
    LogsModalComponent,
    ConfirmModalComponent,
    ApiKeysModalComponent
  ],
  templateUrl: './servers.component.html',
  styleUrls: ['./servers.component.scss']
})
export class ServersComponent implements OnInit, OnDestroy {
  rows: ServerRow[] = [];
  isLoading = true;
  error: string | null = null;

  selectedServerForLogs: HostedServer | null = null;
  serverToDelete: HostedServer | null = null;
  selectedServerForApiKeys: HostedServer | null = null;

  private destroy$ = new Subject<void>();
  private refreshInterval = 30000; // 30 seconds

  constructor(
    private hostingApiService: HostingApiService,
    private myServersApiService: MyServersApiService,
    private conversationService: ConversationService,
    private router: Router,
    private snackBar: MatSnackBar
  ) {}

  ngOnInit(): void {
    this.loadServers();
    this.startAutoRefresh();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  private loadServers(showSpinner = true): void {
    if (showSpinner) {
      this.isLoading = true;
      this.error = null;
    }

    forkJoin({
      myServers: this.myServersApiService.getMyServers(),
      hostedServers: this.hostingApiService.listServers()
    }).subscribe({
      next: ({ myServers, hostedServers }) => {
        const hostedByServerId = new Map(hostedServers.servers.map((s) => [s.serverId, s]));
        this.rows = myServers.map((entry) => ({
          entry,
          hostedServer: entry.hosted ? hostedByServerId.get(entry.hosted.serverId) : undefined
        }));
        this.isLoading = false;
      },
      error: (err) => {
        this.error = err?.error || 'Failed to load servers';
        this.isLoading = false;
      }
    });
  }

  private startAutoRefresh(): void {
    interval(this.refreshInterval)
      .pipe(
        takeUntil(this.destroy$),
        switchMap(() =>
          forkJoin({
            myServers: this.myServersApiService.getMyServers(),
            hostedServers: this.hostingApiService.listServers()
          })
        )
      )
      .subscribe({
        next: ({ myServers, hostedServers }) => {
          const hostedByServerId = new Map(hostedServers.servers.map((s) => [s.serverId, s]));
          this.rows = myServers.map((entry) => ({
            entry,
            hostedServer: entry.hosted ? hostedByServerId.get(entry.hosted.serverId) : undefined
          }));
        },
        error: (err) => {
          console.error('Auto-refresh failed:', err);
        }
      });
  }

  refreshServers(): void {
    this.loadServers();
  }

  openChat(conversationId: string): void {
    this.router.navigate(['/chat', conversationId]);
  }

  /** Ladder step index for the stepper chips: 0=generated, 1=deployed, 2=hosted. */
  stepIndex(status: MyServerEntry['status']): number {
    return status === 'hosted' ? 2 : status === 'deployed' ? 1 : 0;
  }

  async downloadZip(row: ServerRow): Promise<void> {
    const conversationId = row.entry.conversationId;

    this.conversationService.getConversation(conversationId).subscribe({
      next: async (conversation) => {
        let generatedCode = conversation?.state?.generatedCode;

        if (!generatedCode) {
          // Fall back to the last assistant message's metadata, same as the
          // chat page does when conversation.state has no copy.
          this.conversationService.getConversationMessages(conversationId).subscribe({
            next: async (messages) => {
              const lastWithCode = [...messages]
                .reverse()
                .find((m) => m.role === 'assistant' && m.metadata?.generatedCode);
              generatedCode = lastWithCode?.metadata?.generatedCode;
              if (!generatedCode) {
                this.snackBar.open('No generated code found for this server', 'Close', {
                  duration: 3000
                });
                return;
              }
              await this.buildAndDownloadZip(generatedCode, row.entry.serverName);
            },
            error: () => {
              this.snackBar.open('Failed to load generated code', 'Close', { duration: 3000 });
            }
          });
          return;
        }

        await this.buildAndDownloadZip(generatedCode, row.entry.serverName);
      },
      error: () => {
        this.snackBar.open('Failed to load generated code', 'Close', { duration: 3000 });
      }
    });
  }

  /**
   * Builds and downloads a ZIP for a generated server via the shared
   * server-zip util (shared/utils/server-zip.util.ts) - the same builder
   * ChatComponent.downloadAsZip uses, so root-level files (Dockerfile,
   * package.json, etc.) land at the zip root instead of nested under src/.
   */
  private async buildAndDownloadZip(generatedCode: GeneratedServerCode, serverName: string): Promise<void> {
    const slug = (serverName || 'mcp-server').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    await downloadServerZip(generatedCode, `${slug || 'mcp-server'}.zip`);

    this.snackBar.open('ZIP file downloaded', 'Close', { duration: 2000 });
  }

  startServer(server: HostedServer): void {
    this.hostingApiService.startServer(server.serverId).subscribe({
      next: () => {
        this.loadServers(false);
      },
      error: (err) => {
        console.error('Failed to start server:', err);
      }
    });
  }

  stopServer(server: HostedServer): void {
    this.hostingApiService.stopServer(server.serverId).subscribe({
      next: () => {
        this.loadServers(false);
      },
      error: (err) => {
        console.error('Failed to stop server:', err);
      }
    });
  }

  openDeleteConfirmation(server: HostedServer): void {
    this.serverToDelete = server;
  }

  confirmDelete(): void {
    if (!this.serverToDelete) return;

    this.hostingApiService.deleteServer(this.serverToDelete.serverId).subscribe({
      next: () => {
        this.serverToDelete = null;
        this.loadServers(false);
      },
      error: (err) => {
        console.error('Failed to delete server:', err);
        this.serverToDelete = null;
      }
    });
  }

  cancelDelete(): void {
    this.serverToDelete = null;
  }

  openLogs(server: HostedServer): void {
    this.selectedServerForLogs = server;
  }

  closeLogs(): void {
    this.selectedServerForLogs = null;
  }

  openApiKeys(server: HostedServer): void {
    this.selectedServerForApiKeys = server;
  }

  closeApiKeys(): void {
    this.selectedServerForApiKeys = null;
  }
}
