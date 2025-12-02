export enum UserTier {
  FREE = 'free',
  PRO = 'pro',
  ENTERPRISE = 'enterprise',
}

export interface TierLimits {
  monthlyServerLimit: number;
  privateRepos: boolean;
  ciCd: boolean;
  customDomains: boolean;
  sla: boolean;
  prioritySupport: boolean;
  deploymentTypes: ('gist' | 'repo' | 'enterprise')[];
}

export const TIER_CONFIG: Record<UserTier, TierLimits> = {
  [UserTier.FREE]: {
    monthlyServerLimit: 5,
    privateRepos: false,
    ciCd: false,
    customDomains: false,
    sla: false,
    prioritySupport: false,
    deploymentTypes: ['gist'],
  },
  [UserTier.PRO]: {
    monthlyServerLimit: Infinity,
    privateRepos: true,
    ciCd: true,
    customDomains: false,
    sla: false,
    prioritySupport: true,
    deploymentTypes: ['gist', 'repo'],
  },
  [UserTier.ENTERPRISE]: {
    monthlyServerLimit: Infinity,
    privateRepos: true,
    ciCd: true,
    customDomains: true,
    sla: true,
    prioritySupport: true,
    deploymentTypes: ['gist', 'repo', 'enterprise'],
  },
};

export const STRIPE_PRICES = {
  PRO_MONTHLY: {
    priceId: process.env.STRIPE_PRO_MONTHLY_PRICE_ID || 'price_pro_monthly',
    amount: 2900, // $29.00
  },
  PRO_YEARLY: {
    priceId: process.env.STRIPE_PRO_YEARLY_PRICE_ID || 'price_pro_yearly',
    amount: 29000, // $290.00 (2 months free)
  },
  ENTERPRISE_MONTHLY: {
    priceId: process.env.STRIPE_ENTERPRISE_MONTHLY_PRICE_ID || 'price_enterprise_monthly',
    amount: 9900, // $99.00
  },
};

export const TIER_DISPLAY_NAMES: Record<UserTier, string> = {
  [UserTier.FREE]: 'Free',
  [UserTier.PRO]: 'Pro',
  [UserTier.ENTERPRISE]: 'Enterprise',
};

export function getTierFromPriceId(priceId: string): UserTier {
  if (priceId === STRIPE_PRICES.PRO_MONTHLY.priceId || priceId === STRIPE_PRICES.PRO_YEARLY.priceId) {
    return UserTier.PRO;
  }
  if (priceId === STRIPE_PRICES.ENTERPRISE_MONTHLY.priceId) {
    return UserTier.ENTERPRISE;
  }
  return UserTier.FREE;
}
