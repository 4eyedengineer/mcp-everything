import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { AuthService } from '../../../../core/services/auth.service';

@Component({
  selector: 'app-oauth-callback',
  standalone: true,
  imports: [
    CommonModule,
    MatProgressSpinnerModule,
    MatIconModule,
    MatButtonModule
  ],
  templateUrl: './oauth-callback.component.html',
  styleUrls: ['./oauth-callback.component.scss']
})
export class OAuthCallbackComponent implements OnInit {
  isLoading = true;
  error: string | null = null;

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private authService: AuthService
  ) {}

  ngOnInit(): void {
    const token = this.route.snapshot.queryParamMap.get('token');
    const refreshToken = this.route.snapshot.queryParamMap.get('refresh');
    const errorParam = this.route.snapshot.queryParamMap.get('error');

    if (errorParam) {
      this.handleError(errorParam);
      return;
    }

    if (token && refreshToken) {
      this.authService.handleOAuthCallback(token, refreshToken).subscribe({
        next: () => {
          // Navigation is handled in the service
        },
        error: (err: Error) => {
          this.handleError(err.message || 'Authentication failed');
        }
      });
    } else {
      this.handleError('Missing authentication tokens');
    }
  }

  private handleError(message: string): void {
    this.isLoading = false;
    this.error = message;
  }

  goToLogin(): void {
    this.router.navigate(['/auth/login']);
  }

  retry(): void {
    // Go back to the provider to retry
    window.history.back();
  }
}
