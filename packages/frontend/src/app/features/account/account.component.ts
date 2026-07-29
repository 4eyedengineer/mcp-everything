import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { Observable, Subscription } from 'rxjs';
import { SubscriptionService, TierInfo, SubscriptionInfo, UsageInfo } from '../../core/services/subscription.service';
import { AuthService, User } from '../../core/services/auth.service';

interface Settings {
  emailNotifications: boolean;
  autoSave: boolean;
  darkMode: boolean;
}

@Component({
  selector: 'mcp-account',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatIconModule,
    MatTooltipModule,
    MatSnackBarModule
  ],
  templateUrl: './account.component.html',
  styleUrls: ['./account.component.scss']
})
export class AccountComponent implements OnInit, OnDestroy {
  // Real user profile, sourced from AuthService.currentUser$
  user$: Observable<User | null>;

  // Local editable copies of the name/email fields, synced from `user$`
  // whenever not actively editing. Note: there is no backend endpoint yet to
  // persist profile edits - see saveProfile().
  editableName = '';
  editableEmail = '';

  settings: Settings = {
    emailNotifications: true,
    autoSave: true,
    darkMode: false
  };

  isEditingProfile = false;

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
    private snackBar: MatSnackBar
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
      if (user && !this.isEditingProfile) {
        this.editableName = user.name;
        this.editableEmail = user.email;
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
    this.isEditingProfile = false;
    // TODO: No backend endpoint exists yet to persist profile edits.
    console.log('Profile editing is not yet backed by an API - changes are not saved.');
  }

  cancelEdit(): void {
    this.isEditingProfile = false;
    // Reset editable fields back to the last known user values
    const user = this.authService.currentUser;
    if (user) {
      this.editableName = user.name;
      this.editableEmail = user.email;
    }
  }

  saveSettings(): void {
    console.log('Saving settings:', this.settings);
    // TODO: Implement settings save logic
  }

  deleteAccount(): void {
    if (confirm('Are you sure you want to delete your account? This action cannot be undone.')) {
      console.log('Deleting account');
      // TODO: Implement account deletion
    }
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
      // The global error interceptor already shows a toast for the failed
      // request - avoid showing a second, redundant one here.
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
      console.error('Portal session failed:', error);
      // TODO: Show error notification
    }
  }

  getTierDisplayName(tier: string): string {
    return this.subscriptionService.getTierDisplayName(tier);
  }

  isUnlimited(limit: number): boolean {
    return this.subscriptionService.isUnlimited(limit);
  }
}
