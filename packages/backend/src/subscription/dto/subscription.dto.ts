import { IsString, IsOptional, IsIn } from 'class-validator';

export class CreateCheckoutDto {
  @IsString()
  @IsIn(['pro', 'enterprise'])
  tier: 'pro' | 'enterprise';

  @IsOptional()
  @IsString()
  @IsIn(['monthly', 'yearly'])
  interval?: 'monthly' | 'yearly';
}

export interface SubscriptionDto {
  tier: 'free' | 'pro' | 'enterprise';
  status: string;
  currentPeriodStart?: Date;
  currentPeriodEnd?: Date;
  cancelAtPeriodEnd: boolean;
}

export interface UsageDto {
  serversDeployedThisMonth: number;
  monthlyLimit: number;
  periodStart: Date;
  periodEnd: Date;
  percentUsed: number;
  remainingDeployments: number;
}

export interface TierInfoDto {
  currentTier: 'free' | 'pro' | 'enterprise';
  limits: {
    monthlyServerLimit: number;
    privateRepos: boolean;
    ciCd: boolean;
    customDomains: boolean;
    sla: boolean;
    prioritySupport: boolean;
  };
  usage: {
    serversDeployed: number;
    limit: number;
    periodEnd: Date;
  };
  canUpgrade: boolean;
}

export interface CheckoutSessionDto {
  sessionId: string;
  url: string;
}

export interface PortalSessionDto {
  url: string;
}
