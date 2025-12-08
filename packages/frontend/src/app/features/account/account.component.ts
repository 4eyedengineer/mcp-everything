import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { Observable, Subscription } from 'rxjs';
import { SubscriptionService, TierInfo, SubscriptionInfo, UsageInfo } from '../../core/services/subscription.service';

interface UserProfile {
  email: string;
  name: string;
  apiKey: string;
  serversGenerated: number;
  storageUsed: string;
}

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
  // Placeholder data - will be replaced with actual user data
  profile: UserProfile = {
    email: 'user@example.com',
    name: 'John Doe',
    apiKey: 'mcp_sk_xxxxxxxxxxxxxxxxxxxxxxxx',
    serversGenerated: 12,
    storageUsed: '245 MB'
  };

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

  constructor(
    private subscriptionService: SubscriptionService,
    private route: ActivatedRoute,
    private router: Router,
    private snackBar: MatSnackBar
  ) {
    this.tierInfo$ = this.subscriptionService.tierInfo$;
    this.subscription$ = this.subscriptionService.subscription$;
    this.usage$ = this.subscriptionService.usage$;
  }

  ngOnInit(): void {
    this.loadSubscriptionData();
    this.handleCheckoutResult();
  }

  ngOnDestroy(): void {
    this.queryParamsSub?.unsubscribe();
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
    console.log('Saving profile:', this.profile);
    // TODO: Implement actual profile save logic
  }

  cancelEdit(): void {
    this.isEditingProfile = false;
    // TODO: Reset profile to original values
  }

  copyApiKey(): void {
    navigator.clipboard.writeText(this.profile.apiKey);
    console.log('API key copied to clipboard');
    // TODO: Show snackbar notification
  }

  regenerateApiKey(): void {
    console.log('Regenerating API key');
    // TODO: Implement API key regeneration
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
      console.error('Checkout failed:', error);
      this.snackBar.open('Failed to start checkout. Please try again.', 'Dismiss', {
        duration: 5000,
        panelClass: ['error-snackbar']
      });
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
