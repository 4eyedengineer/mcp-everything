import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { Subject, interval } from 'rxjs';
import { takeUntil, startWith, switchMap } from 'rxjs/operators';

import { HostingApiService, HostedServer } from '../../core/services/hosting-api.service';
import { ServerManagementCardComponent } from './components/server-management-card/server-management-card.component';
import { LogsModalComponent } from './components/logs-modal/logs-modal.component';
import { ConfirmModalComponent } from './components/confirm-modal/confirm-modal.component';

@Component({
  selector: 'mcp-servers',
  standalone: true,
  imports: [
    CommonModule,
    RouterModule,
    MatIconModule,
    MatButtonModule,
    MatProgressSpinnerModule,
    ServerManagementCardComponent,
    LogsModalComponent,
    ConfirmModalComponent
  ],
  templateUrl: './servers.component.html',
  styleUrls: ['./servers.component.scss']
})
export class ServersComponent implements OnInit, OnDestroy {
  servers: HostedServer[] = [];
  isLoading = true;
  error: string | null = null;

  selectedServerForLogs: HostedServer | null = null;
  serverToDelete: HostedServer | null = null;

  private destroy$ = new Subject<void>();
  private refreshInterval = 30000; // 30 seconds

  constructor(private hostingApiService: HostingApiService) {}

  ngOnInit(): void {
    this.loadServers();
    this.startAutoRefresh();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  private loadServers(): void {
    this.isLoading = true;
    this.error = null;

    this.hostingApiService.listServers().subscribe({
      next: (response) => {
        this.servers = response.servers;
        this.isLoading = false;
      },
      error: (err) => {
        this.error = err.error || 'Failed to load servers';
        this.isLoading = false;
      }
    });
  }

  private startAutoRefresh(): void {
    interval(this.refreshInterval)
      .pipe(
        takeUntil(this.destroy$),
        switchMap(() => this.hostingApiService.listServers())
      )
      .subscribe({
        next: (response) => {
          this.servers = response.servers;
        },
        error: (err) => {
          console.error('Auto-refresh failed:', err);
        }
      });
  }

  refreshServers(): void {
    this.loadServers();
  }

  startServer(server: HostedServer): void {
    this.hostingApiService.startServer(server.serverId).subscribe({
      next: () => {
        this.loadServers();
      },
      error: (err) => {
        console.error('Failed to start server:', err);
      }
    });
  }

  stopServer(server: HostedServer): void {
    this.hostingApiService.stopServer(server.serverId).subscribe({
      next: () => {
        this.loadServers();
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
        this.loadServers();
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
}
