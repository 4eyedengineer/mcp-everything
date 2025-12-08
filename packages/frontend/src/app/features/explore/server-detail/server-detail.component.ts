import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTabsModule } from '@angular/material/tabs';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatChipsModule } from '@angular/material/chips';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { ClipboardModule, Clipboard } from '@angular/cdk/clipboard';
import {
  MarketplaceService,
  ServerResponse,
  McpToolResponse,
  McpResourceResponse,
} from '../../../core/services/marketplace.service';
import { NotificationService } from '../../../core/services/notification.service';

@Component({
  selector: 'mcp-server-detail',
  standalone: true,
  imports: [
    CommonModule,
    RouterModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatTabsModule,
    MatExpansionModule,
    MatChipsModule,
    MatTooltipModule,
    MatSnackBarModule,
    ClipboardModule,
  ],
  templateUrl: './server-detail.component.html',
  styleUrls: ['./server-detail.component.scss'],
})
export class ServerDetailComponent implements OnInit {
  server: ServerResponse | null = null;
  isLoading = true;
  error: string | null = null;

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private marketplaceService: MarketplaceService,
    private notificationService: NotificationService,
    private snackBar: MatSnackBar,
    private clipboard: Clipboard
  ) {}

  ngOnInit(): void {
    const slug = this.route.snapshot.paramMap.get('slug');
    if (slug) {
      this.loadServer(slug);
    } else {
      this.error = 'Server not found';
      this.isLoading = false;
    }
  }

  loadServer(slug: string): void {
    this.isLoading = true;
    this.error = null;

    this.marketplaceService.getBySlug(slug).subscribe({
      next: (server) => {
        this.server = server;
        this.isLoading = false;
      },
      error: (err) => {
        console.error('Failed to load server:', err);
        this.error = 'Failed to load server details. Please try again.';
        this.isLoading = false;
      },
    });
  }

  downloadServer(): void {
    if (!this.server) return;

    this.marketplaceService.recordDownload(this.server.id).subscribe({
      next: () => {
        if (this.server?.downloadUrl) {
          window.open(this.server.downloadUrl, '_blank');
        } else if (this.server?.gistUrl) {
          window.open(this.server.gistUrl, '_blank');
        } else if (this.server?.repositoryUrl) {
          window.open(this.server.repositoryUrl, '_blank');
        } else {
          this.notificationService.info(`Download started for ${this.server?.name}`);
        }

        // Update local count
        if (this.server) {
          this.server = { ...this.server, downloadCount: this.server.downloadCount + 1 };
        }
      },
      error: (err) => {
        console.error('Failed to record download:', err);
        this.notificationService.error('Failed to download server');
      },
    });
  }

  openGitHub(): void {
    if (this.server?.repositoryUrl) {
      window.open(this.server.repositoryUrl, '_blank');
    }
  }

  openGist(): void {
    if (this.server?.gistUrl) {
      window.open(this.server.gistUrl, '_blank');
    }
  }

  goBack(): void {
    this.router.navigate(['/explore']);
  }

  copyInstallCommand(): void {
    const command = this.getInstallCommand();
    this.clipboard.copy(command);
    this.snackBar.open('Copied to clipboard!', 'Close', { duration: 2000 });
  }

  getInstallCommand(): string {
    if (!this.server) return '';

    if (this.server.repositoryUrl) {
      return `npx @anthropic/mcp-install ${this.server.repositoryUrl}`;
    }
    if (this.server.gistUrl) {
      return `npx @anthropic/mcp-install ${this.server.gistUrl}`;
    }
    return `npm install ${this.server.slug}`;
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
    return icons[this.server?.category || 'other'] || 'memory';
  }

  getCategoryLabel(): string {
    const labels: Record<string, string> = {
      api: 'API Integration',
      database: 'Database',
      utility: 'Utility',
      ai: 'AI & ML',
      devtools: 'Developer Tools',
      communication: 'Communication',
      storage: 'Storage',
      analytics: 'Analytics',
      other: 'Other',
    };
    return labels[this.server?.category || 'other'] || 'Other';
  }

  getAuthorDisplay(): string {
    if (!this.server?.author) {
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

  getLanguageLabel(): string {
    const labels: Record<string, string> = {
      typescript: 'TypeScript',
      javascript: 'JavaScript',
      python: 'Python',
    };
    return labels[this.server?.language || 'typescript'] || 'TypeScript';
  }

  formatInputSchema(schema: Record<string, unknown> | undefined): string {
    if (!schema) return 'No input schema';
    return JSON.stringify(schema, null, 2);
  }

  hasLinks(): boolean {
    return !!(this.server?.repositoryUrl || this.server?.gistUrl || this.server?.downloadUrl);
  }
}
