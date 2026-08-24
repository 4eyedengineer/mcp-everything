import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute, Router } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { Observable, Subscription } from 'rxjs';
import { API_BASE } from '../../core/config/api.config';
import { SubscriptionService, TierInfo, SubscriptionInfo, UsageInfo } from '../../core/services/subscription.service';
import { AuthService, User, userDisplayName } from '../../core/services/auth.service';
import { ApiKeySectionComponent } from './sections/api-key-section/api-key-section.component';
import { UsageStatsSectionComponent } from './sections/usage-stats-section/usage-stats-section.component';
import { GithubConnectionSectionComponent } from './sections/github-connection-section/github-connection-section.component';
import { ThemeToggleComponent } from '../../shared/components/theme-toggle/theme-toggle.component';
import { ConfirmDialogComponent, ConfirmDialogData } from '../../shared/components/confirm-dialog/confirm-dialog.component';
import { billingErrorMessage } from '../../shared/utils/billing-error.util';

interface Settings {
  emailNotifications: boolean;
  autoSave: boolean;
  darkMode: boolean;
}

/** Shape returned by GET/PATCH `${API_BASE}/account` (see backend AccountDto). */
interface AccountDto {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  tier: string;
  isEmailVerified: boolean;
  createdAt: string;
}

@Component({
  selector: 'mcp-account',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatIconModule,
    MatTooltipModule,
    MatSnackBarModule,
    MatDialogModule,
    ApiKeySectionComponent,
    UsageStatsSectionComponent,
    GithubConnectionSectionComponent,
    ThemeToggleComponent
  ],
  templateUrl: './account.component.html',
  styleUrls: ['./account.component.scss']
})
export class AccountComponent implements OnInit, OnDestroy {
  // Real user profile, sourced from AuthService.currentUser$
  user$: Observable<User | null>;

  // Local editable copies of the name/email fields, synced from `user$`
  // whenever not actively editing. Email is read-only (see account.component.html) -
  // the backend account endpoint (UpdateAccountDto) does not support email
  // changes, only firstName/lastName.
  editableName = '';
  editableEmail = '';

  // Preferences have no backend endpoint yet, so they're persisted to
  // localStorage instead (see loadSettings()/saveSettings()), keyed per user
  // id so switching accounts on the same browser doesn't leak one user's
  // preferences into another's. Theme is handled separately by ThemeService
  // and is not part of this object.
  settings: Settings = {
    emailNotifications: true,
    autoSave: true,
    darkMode: false
  };
  private settingsLoadedForUserId: string | null = null;

  isEditingProfile = false;
  isSavingProfile = false;
  isDeletingAccount = false;

  // Subscription data
  tierInfo$: Observable<TierInfo | null>;
  subscription$: Observable<SubscriptionInfo | null>;
  usage$: Observable<UsageInfo | null>;
  isUpgrading = false;
  checkoutMessage: string | null = null;
  checkoutSuccess = false;
  private queryParamsSub: Subscription | null = null;
  private userSub: Subscription | null = null;

  constructor(
    private authService: AuthService,
    private subscriptionService: SubscriptionService,
    private route: ActivatedRoute,
    private router: Router,
    private snackBar: MatSnackBar,
    private dialog: MatDialog,
    private http: HttpClient
  ) {
    this.user$ = this.authService.currentUser$;
    this.tierInfo$ = this.subscriptionService.tierInfo$;
    this.subscription$ = this.subscriptionService.subscription$;
    this.usage$ = this.subscriptionService.usage$;
  }

  ngOnInit(): void {
    this.loadSubscriptionData();
    this.handleCheckoutResult();

    this.userSub = this.user$.subscribe(user => {
      if (user) {
        if (this.settingsLoadedForUserId !== user.id) {
          this.loadSettings(user.id);
          this.settingsLoadedForUserId = user.id;
        }
        if (!this.isEditingProfile) {
          this.editableName = userDisplayName(user);
          this.editableEmail = user.email;
        }
      }
    });
  }

  ngOnDestroy(): void {
    this.queryParamsSub?.unsubscribe();
    this.userSub?.unsubscribe();
  }

  private loadSubscriptionData(): void {
    this.subscriptionService.getTierInfo().subscribe();
    this.subscriptionService.getSubscription().subscribe();
    this.subscriptionService.getUsage().subscribe();
  }

  private handleCheckoutResult(): void {
    this.queryParamsSub = this.route.queryParams.subscribe(params => {
      if (params['success'] === 'true') {
        this.checkoutSuccess = true;
        this.checkoutMessage = 'Your subscription has been activated! Thank you for upgrading.';
        this.snackBar.open(this.checkoutMessage, 'Dismiss', {
          duration: 5000,
          panelClass: ['success-snackbar']
        });
        // Refresh subscription data to reflect the new tier
        this.subscriptionService.refreshAll();
        // Clean up URL
        this.router.navigate([], {
          relativeTo: this.route,
          queryParams: {},
          replaceUrl: true
        });
      } else if (params['canceled'] === 'true') {
        this.checkoutSuccess = false;
        this.checkoutMessage = 'Checkout was cancelled. You can try again when ready.';
        this.snackBar.open(this.checkoutMessage, 'Dismiss', {
          duration: 5000,
          panelClass: ['info-snackbar']
        });
        // Clean up URL
        this.router.navigate([], {
          relativeTo: this.route,
          queryParams: {},
          replaceUrl: true
        });
      }
    });
  }

  editProfile(): void {
    this.isEditingProfile = true;
  }

  saveProfile(): void {
    // The form collects one full-name field; the API takes firstName/lastName
    // (same split convention used at registration - see register.component.ts).
    const [firstName, ...rest] = this.editableName.trim().split(/\s+/);
    const lastName = rest.join(' ') || undefined;

    this.isSavingProfile = true;
    this.http.patch<AccountDto>(`${API_BASE}/account`, { firstName, lastName }).subscribe({
      next: () => {
        this.isSavingProfile = false;
        this.isEditingProfile = false;
        // Refresh AuthService's currentUser so the rest of the app (top-nav,
        // greeting, etc.) picks up the new name immediately.
        this.authService.getProfile().subscribe();
        this.snackBar.open('Profile updated', 'Dismiss', { duration: 3000 });
      },
      error: () => {
        // The global error interceptor already shows a toast for the failed
        // request - avoid a second, redundant one here.
        this.isSavingProfile = false;
      }
    });
  }

  cancelEdit(): void {
    this.isEditingProfile = false;
    // Reset editable fields back to the last known user values
    const user = this.authService.currentUser;
    if (user) {
      this.editableName = userDisplayName(user);
      this.editableEmail = user.email;
    }
  }

  private settingsStorageKey(userId: string): string {
    return `mcp-account-settings-${userId}`;
  }

  private loadSettings(userId: string): void {
    try {
      const raw = localStorage.getItem(this.settingsStorageKey(userId));
      if (raw) {
        this.settings = { ...this.settings, ...JSON.parse(raw) };
      }
    } catch {
      // Corrupt JSON or storage unavailable - fall back to defaults.
    }
  }

  saveSettings(): void {
    // No backend preferences endpoint exists yet, so these persist to
    // localStorage only (client-side, per browser) rather than syncing
    // across devices - keyed per user id so switching accounts on the same
    // browser doesn't leak one user's preferences into another's.
    const user = this.authService.currentUser;
    if (!user) {
      return;
    }
    try {
      localStorage.setItem(this.settingsStorageKey(user.id), JSON.stringify(this.settings));
    } catch {
      // localStorage may be unavailable (private browsing, quota exceeded) -
      // preferences simply won't persist across reloads in that case.
    }
  }

  deleteAccount(): void {
    const dialogRef = this.dialog.open<ConfirmDialogComponent, ConfirmDialogData, boolean>(
      ConfirmDialogComponent,
      {
        width: '420px',
        data: {
          title: 'Delete your account?',
          message: 'This will permanently delete your account, generated MCP servers, and conversation history. This action cannot be undone.',
          confirmLabel: 'Delete Account',
          destructive: true
        }
      }
    );

    dialogRef.afterClosed().subscribe(confirmed => {
      if (!confirmed) {
        return;
      }

      this.isDeletingAccount = true;
      this.http.delete<{ success: boolean }>(`${API_BASE}/account`).subscribe({
        next: () => {
          this.snackBar.open(
            "Your account has been deleted. Thanks for trying MCP Everything - we're sorry to see you go.",
            'Dismiss',
            { duration: 6000 }
          );
          this.authService.logout();
        },
        error: () => {
          // The global error interceptor already shows a toast for the
          // failed request - avoid a second, redundant one here.
          this.isDeletingAccount = false;
        }
      });
    });
  }

  // Subscription management methods
  selectedBillingInterval: 'monthly' | 'yearly' = 'monthly';

  async upgradeToPro(): Promise<void> {
    await this.startCheckout('pro', this.selectedBillingInterval);
  }

  async upgradeToEnterprise(): Promise<void> {
    await this.startCheckout('enterprise', 'monthly');
  }

  async startCheckout(tier: 'pro' | 'enterprise', interval: 'monthly' | 'yearly' = 'monthly'): Promise<void> {
    this.isUpgrading = true;
    try {
      const result = await this.subscriptionService.createCheckout(tier, interval).toPromise();
      if (result?.url) {
        window.location.href = result.url;
      }
    } catch (error) {
      // Surface a specific, honest message: "not available yet" when billing
      // is unconfigured (400), otherwise the parsed backend/network error.
      const message = billingErrorMessage(error, "We couldn't start checkout. Please try again.");
      this.snackBar.open(message, 'Dismiss', { duration: 6000 });
      console.error('Checkout failed:', error);
    } finally {
      this.isUpgrading = false;
    }
  }

  selectBillingInterval(interval: 'monthly' | 'yearly'): void {
    this.selectedBillingInterval = interval;
  }

  async manageSubscription(): Promise<void> {
    try {
      const result = await this.subscriptionService.createPortal().toPromise();
      if (result?.url) {
        window.location.href = result.url;
      }
    } catch (error) {
      const message = billingErrorMessage(error, "We couldn't open the billing portal. Please try again.");
      this.snackBar.open(message, 'Dismiss', { duration: 6000 });
      console.error('Portal session failed:', error);
    }
  }

  getTierDisplayName(tier: string): string {
    return this.subscriptionService.getTierDisplayName(tier);
  }

  isUnlimited(limit: number): boolean {
    return this.subscriptionService.isUnlimited(limit);
  }
}
