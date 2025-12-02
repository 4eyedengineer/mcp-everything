import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, BehaviorSubject, tap, catchError, of } from 'rxjs';
import { environment } from '../../../environments/environment';

export interface TierLimits {
  monthlyServerLimit: number;
  privateRepos: boolean;
  ciCd: boolean;
  customDomains: boolean;
  sla: boolean;
  prioritySupport: boolean;
}

export interface TierInfo {
  currentTier: 'free' | 'pro' | 'enterprise';
  limits: TierLimits;
  usage: {
    serversDeployed: number;
    limit: number;
    periodEnd: string;
  };
  canUpgrade: boolean;
}

export interface SubscriptionInfo {
  tier: 'free' | 'pro' | 'enterprise';
  status: 'active' | 'canceled' | 'past_due' | 'incomplete' | 'trialing';
  currentPeriodStart?: string;
  currentPeriodEnd?: string;
  cancelAtPeriodEnd: boolean;
}

export interface UsageInfo {
  serversDeployedThisMonth: number;
  monthlyLimit: number;
  periodStart: string;
  periodEnd: string;
  percentUsed: number;
  remainingDeployments: number;
}

export interface CheckoutSession {
  sessionId: string;
  url: string;
}

export interface PortalSession {
  url: string;
}

export interface DeploymentLimitError {
  code: 'LIMIT_EXCEEDED' | 'TIER_RESTRICTION' | 'USER_NOT_FOUND';
  message: string;
  currentUsage?: number;
  limit?: number;
  currentTier?: string;
  requiredTier?: string;
  upgradeUrl: string;
}

@Injectable({
  providedIn: 'root'
})
export class SubscriptionService {
  private readonly baseUrl = `${environment.apiUrl}/api/subscription`;

  private tierInfoSubject = new BehaviorSubject<TierInfo | null>(null);
  private subscriptionSubject = new BehaviorSubject<SubscriptionInfo | null>(null);
  private usageSubject = new BehaviorSubject<UsageInfo | null>(null);

  public tierInfo$ = this.tierInfoSubject.asObservable();
  public subscription$ = this.subscriptionSubject.asObservable();
  public usage$ = this.usageSubject.asObservable();

  constructor(private http: HttpClient) {}

  getSubscription(): Observable<SubscriptionInfo> {
    return this.http.get<SubscriptionInfo>(this.baseUrl).pipe(
      tap(subscription => this.subscriptionSubject.next(subscription)),
      catchError(error => {
        console.error('Failed to get subscription:', error);
        return of({
          tier: 'free' as const,
          status: 'active' as const,
          cancelAtPeriodEnd: false
        });
      })
    );
  }

  getTierInfo(): Observable<TierInfo> {
    return this.http.get<TierInfo>(`${this.baseUrl}/tier`).pipe(
      tap(tierInfo => this.tierInfoSubject.next(tierInfo)),
      catchError(error => {
        console.error('Failed to get tier info:', error);
        return of({
          currentTier: 'free' as const,
          limits: {
            monthlyServerLimit: 5,
            privateRepos: false,
            ciCd: false,
            customDomains: false,
            sla: false,
            prioritySupport: false
          },
          usage: {
            serversDeployed: 0,
            limit: 5,
            periodEnd: new Date().toISOString()
          },
          canUpgrade: true
        });
      })
    );
  }

  getUsage(): Observable<UsageInfo> {
    return this.http.get<UsageInfo>(`${this.baseUrl}/usage`).pipe(
      tap(usage => this.usageSubject.next(usage)),
      catchError(error => {
        console.error('Failed to get usage:', error);
        return of({
          serversDeployedThisMonth: 0,
          monthlyLimit: 5,
          periodStart: new Date().toISOString(),
          periodEnd: new Date().toISOString(),
          percentUsed: 0,
          remainingDeployments: 5
        });
      })
    );
  }

  createCheckout(tier: 'pro' | 'enterprise', interval: 'monthly' | 'yearly' = 'monthly'): Observable<CheckoutSession> {
    return this.http.post<CheckoutSession>(`${this.baseUrl}/checkout`, { tier, interval });
  }

  createPortal(): Observable<PortalSession> {
    return this.http.post<PortalSession>(`${this.baseUrl}/portal`, {});
  }

  refreshAll(): void {
    this.getSubscription().subscribe();
    this.getTierInfo().subscribe();
    this.getUsage().subscribe();
  }

  isDeploymentLimitError(error: any): error is { error: DeploymentLimitError } {
    return error?.error?.code && ['LIMIT_EXCEEDED', 'TIER_RESTRICTION', 'USER_NOT_FOUND'].includes(error.error.code);
  }

  getTierDisplayName(tier: string): string {
    switch (tier) {
      case 'free': return 'Free';
      case 'pro': return 'Pro';
      case 'enterprise': return 'Enterprise';
      default: return tier;
    }
  }

  isUnlimited(limit: number): boolean {
    return limit >= 999999;
  }
}
