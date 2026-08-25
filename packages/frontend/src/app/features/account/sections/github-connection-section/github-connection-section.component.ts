import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { GitHubService, GitHubConnectionStatus } from '../../../../core/services/github.service';
import { AuthService } from '../../../../core/services/auth.service';
import { ConfirmDialogComponent, ConfirmDialogData } from '../../../../shared/components/confirm-dialog/confirm-dialog.component';

/**
 * Self-contained "Connected Accounts" section for the Account page: shows
 * whether the user has a GitHub account connected (used by the chat page's
 * repo-picker modal to list their own repositories - see
 * GitHubService/GithubRepoPanelState), and lets them connect or disconnect it.
 *
 * Mirrors ApiKeySectionComponent's markup/pattern so it looks native on the
 * Account page while shipping its own scoped styles.
 */
@Component({
  selector: 'mcp-github-connection-section',
  standalone: true,
  imports: [CommonModule, MatIconModule, MatSnackBarModule, MatDialogModule],
  templateUrl: './github-connection-section.component.html',
  styleUrls: ['./github-connection-section.component.scss'],
})
export class GithubConnectionSectionComponent implements OnInit {
  loading = signal(true);
  status = signal<GitHubConnectionStatus | null>(null);
  error = signal<string | null>(null);
  isDisconnecting = signal(false);

  constructor(
    private readonly githubService: GitHubService,
    private readonly authService: AuthService,
    private readonly snackBar: MatSnackBar,
    private readonly dialog: MatDialog,
  ) {}

  ngOnInit(): void {
    this.loadStatus();
  }

  private loadStatus(): void {
    this.loading.set(true);
    this.error.set(null);
    this.githubService.getConnectionStatus().subscribe({
      next: (status) => {
        this.loading.set(false);
        this.status.set(status);
      },
      error: () => {
        this.loading.set(false);
        this.error.set('Could not load your GitHub connection status right now.');
      },
    });
  }

  connect(): void {
    // Full-page redirect through GitHub's OAuth flow, same one used for
    // login/register - see repo-picker-modal.component.ts#connectGithub for
    // the caveat about email-based account resolution on the callback.
    window.location.href = this.authService.getGitHubLoginUrl();
  }

  disconnect(): void {
    const dialogRef = this.dialog.open<ConfirmDialogComponent, ConfirmDialogData, boolean>(
      ConfirmDialogComponent,
      {
        width: '420px',
        data: {
          title: 'Disconnect GitHub?',
          message:
            'This revokes MCP Everything\'s access to your GitHub account and removes the stored connection. ' +
            'You can reconnect at any time. Your repositories, deployments, and account itself are not affected.',
          confirmLabel: 'Disconnect',
          destructive: true,
        },
      },
    );

    dialogRef.afterClosed().subscribe((confirmed) => {
      if (!confirmed) {
        return;
      }

      this.isDisconnecting.set(true);
      this.githubService.disconnect().subscribe({
        next: () => {
          this.isDisconnecting.set(false);
          this.snackBar.open('GitHub account disconnected', 'Dismiss', { duration: 3000 });
          this.loadStatus();
        },
        error: () => {
          this.isDisconnecting.set(false);
          // The global error interceptor already shows a toast for the
          // failed request - avoid a second, redundant one here.
        },
      });
    });
  }
}
