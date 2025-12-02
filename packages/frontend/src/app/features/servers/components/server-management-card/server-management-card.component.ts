import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressBarModule } from '@angular/material/progress-bar';

import { HostedServer, HostedServerStatus } from '../../../../core/services/hosting-api.service';
import { TimeAgoPipe } from '../../../../shared/pipes/time-ago.pipe';

@Component({
  selector: 'mcp-server-management-card',
  standalone: true,
  imports: [
    CommonModule,
    MatIconModule,
    MatButtonModule,
    MatTooltipModule,
    MatProgressBarModule,
    TimeAgoPipe
  ],
  templateUrl: './server-management-card.component.html',
  styleUrls: ['./server-management-card.component.scss']
})
export class ServerManagementCardComponent {
  @Input() server!: HostedServer;
  @Output() start = new EventEmitter<HostedServer>();
  @Output() stop = new EventEmitter<HostedServer>();
  @Output() delete = new EventEmitter<HostedServer>();
  @Output() viewLogs = new EventEmitter<HostedServer>();

  get isDeploying(): boolean {
    const deployingStates: HostedServerStatus[] = ['pending', 'building', 'pushing', 'deploying'];
    return deployingStates.includes(this.server.status);
  }

  get deployProgress(): number {
    const stages: HostedServerStatus[] = ['pending', 'building', 'pushing', 'deploying', 'running'];
    const index = stages.indexOf(this.server.status);
    if (index === -1) return 0;
    return ((index + 1) / stages.length) * 100;
  }

  get statusClass(): string {
    switch (this.server.status) {
      case 'running':
        return 'status-running';
      case 'stopped':
        return 'status-stopped';
      case 'failed':
        return 'status-failed';
      case 'pending':
      case 'building':
      case 'pushing':
      case 'deploying':
        return 'status-deploying';
      default:
        return 'status-unknown';
    }
  }

  get statusIcon(): string {
    switch (this.server.status) {
      case 'running':
        return 'check_circle';
      case 'stopped':
        return 'stop_circle';
      case 'failed':
        return 'error';
      case 'pending':
      case 'building':
      case 'pushing':
      case 'deploying':
        return 'pending';
      default:
        return 'help';
    }
  }

  get statusLabel(): string {
    return this.server.status.charAt(0).toUpperCase() + this.server.status.slice(1);
  }

  copyEndpoint(): void {
    navigator.clipboard.writeText(this.server.endpointUrl);
  }

  copyClaudeConfig(): void {
    const serverSlug = this.server.serverName.toLowerCase().replace(/\s+/g, '-');
    const config = {
      mcpServers: {
        [serverSlug]: {
          command: 'mcp-connect',
          args: [this.server.serverId]
        }
      }
    };
    navigator.clipboard.writeText(JSON.stringify(config, null, 2));
  }

  onStart(): void {
    this.start.emit(this.server);
  }

  onStop(): void {
    this.stop.emit(this.server);
  }

  onDelete(): void {
    this.delete.emit(this.server);
  }

  onViewLogs(): void {
    this.viewLogs.emit(this.server);
  }
}
