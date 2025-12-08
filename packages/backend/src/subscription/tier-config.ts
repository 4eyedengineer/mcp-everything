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
  features: string[];
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
    features: ['Basic generation', 'Community support', '5 servers/month'],
  },
  [UserTier.PRO]: {
    monthlyServerLimit: Infinity,
    privateRepos: true,
    ciCd: true,
    customDomains: false,
    sla: false,
    prioritySupport: true,
    deploymentTypes: ['gist', 'repo'],
    features: [
      'Unlimited generation',
      'Priority support',
      'Private repositories',
      'CI/CD integration',
    ],
  },
  [UserTier.ENTERPRISE]: {
    monthlyServerLimit: Infinity,
    privateRepos: true,
    ciCd: true,
    customDomains: true,
    sla: true,
    prioritySupport: true,
    deploymentTypes: ['gist', 'repo', 'enterprise'],
    features: [
      'Everything in Pro',
      'Custom domains',
      'Team features',
      'SSO integration',
      'SLA guarantee',
    ],
  },
};

/**
 * Stripe price configuration.
 *
 * Environment variables:
 * - STRIPE_PRICE_FREE: Price ID for free tier (optional, used for $0 subscriptions)
 * - STRIPE_PRICE_PRO: Price ID for Pro monthly tier ($29/month)
 * - STRIPE_PRICE_PRO_YEARLY: Price ID for Pro yearly tier ($290/year, 2 months free)
 * - STRIPE_PRICE_ENTERPRISE: Price ID for Enterprise monthly tier ($99/month)
 *
 * See docs/STRIPE_SETUP.md for instructions on creating these products in Stripe Dashboard.
 */
export const STRIPE_PRICES = {
  FREE: {
    priceId: process.env.STRIPE_PRICE_FREE || '',
    amount: 0, // $0.00
    tier: UserTier.FREE,
  },
  PRO_MONTHLY: {
    priceId: process.env.STRIPE_PRICE_PRO || '',
    amount: 2900, // $29.00
    tier: UserTier.PRO,
  },
  PRO_YEARLY: {
    priceId: process.env.STRIPE_PRICE_PRO_YEARLY || '',
    amount: 29000, // $290.00 (2 months free)
    tier: UserTier.PRO,
  },
  ENTERPRISE_MONTHLY: {
    priceId: process.env.STRIPE_PRICE_ENTERPRISE || '',
    amount: 9900, // $99.00
    tier: UserTier.ENTERPRISE,
  },
};

export const TIER_DISPLAY_NAMES: Record<UserTier, string> = {
  [UserTier.FREE]: 'Free',
  [UserTier.PRO]: 'Pro',
  [UserTier.ENTERPRISE]: 'Enterprise',
};

/**
 * Get the user tier from a Stripe price ID.
 * Used during webhook processing to determine tier from subscription.
 */
export function getTierFromPriceId(priceId: string): UserTier {
  // Check all configured prices
  for (const [, config] of Object.entries(STRIPE_PRICES)) {
    if (config.priceId && config.priceId === priceId) {
      return config.tier;
    }
  }
  // Default to free if price ID not recognized
  return UserTier.FREE;
}

/**
 * Get the Stripe price ID for a specific tier and billing interval.
 */
export function getPriceIdForTier(
  tier: 'pro' | 'enterprise',
  interval: 'monthly' | 'yearly' = 'monthly',
): string {
  if (tier === 'pro') {
    return interval === 'yearly'
      ? STRIPE_PRICES.PRO_YEARLY.priceId
      : STRIPE_PRICES.PRO_MONTHLY.priceId;
  }
  return STRIPE_PRICES.ENTERPRISE_MONTHLY.priceId;
}
