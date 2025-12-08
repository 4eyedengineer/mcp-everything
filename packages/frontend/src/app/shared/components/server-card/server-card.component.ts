import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { ServerSummaryResponse } from '../../../core/services/marketplace.service';

@Component({
  selector: 'mcp-server-card',
  standalone: true,
  imports: [CommonModule, MatIconModule],
  templateUrl: './server-card.component.html',
  styleUrls: ['./server-card.component.scss'],
})
export class ServerCardComponent {
  @Input({ required: true }) server!: ServerSummaryResponse;
  @Input() showActions = true;

  @Output() viewDetails = new EventEmitter<ServerSummaryResponse>();
  @Output() download = new EventEmitter<ServerSummaryResponse>();

  onViewDetails(): void {
    this.viewDetails.emit(this.server);
  }

  onDownload(): void {
    this.download.emit(this.server);
  }

  getCategoryIcon(): string {
    const icons: Record<string, string> = {
      api: 'api',
      database: 'storage',
      utility: 'build',
      ai: 'psychology',
      devtools: 'code',
      communication: 'chat',
      storage: 'cloud',
      analytics: 'analytics',
      other: 'memory',
    };
    return icons[this.server.category] || 'memory';
  }

  getAuthorDisplay(): string {
    if (!this.server.author) {
      return 'Anonymous';
    }
    if (this.server.author.githubUsername) {
      return `@${this.server.author.githubUsername}`;
    }
    if (this.server.author.firstName || this.server.author.lastName) {
      return `${this.server.author.firstName || ''} ${this.server.author.lastName || ''}`.trim();
    }
    return 'Anonymous';
  }

  getLanguageIcon(): string {
    const icons: Record<string, string> = {
      typescript: 'code',
      javascript: 'javascript',
      python: 'code',
    };
    return icons[this.server.language] || 'code';
  }
}
