/// <reference types="jest" />

/**
 * tier-config resolves Stripe price ids <-> user tiers. Because the price ids
 * are read from `process.env` at *module load* time (via the STRIPE_PRICES
 * object), these tests set the env vars and re-require the module in isolation
 * so the mapping under test reflects a known configuration.
 */
describe('tier-config price mapping', () => {
  const ENV = {
    STRIPE_PRICE_PRO: 'price_pro_monthly',
    STRIPE_PRICE_PRO_YEARLY: 'price_pro_yearly',
    STRIPE_PRICE_ENTERPRISE: 'price_enterprise_monthly',
  };

  function loadModule() {
    let mod!: typeof import('./tier-config');
    jest.isolateModules(() => {
      mod = require('./tier-config');
    });
    return mod;
  }

  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {
      STRIPE_PRICE_PRO: process.env.STRIPE_PRICE_PRO,
      STRIPE_PRICE_PRO_YEARLY: process.env.STRIPE_PRICE_PRO_YEARLY,
      STRIPE_PRICE_ENTERPRISE: process.env.STRIPE_PRICE_ENTERPRISE,
    };
    Object.assign(process.env, ENV);
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  describe('getTierFromPriceId', () => {
    it('maps the pro monthly and yearly price ids to PRO', () => {
      const { getTierFromPriceId, UserTier } = loadModule();
      expect(getTierFromPriceId('price_pro_monthly')).toBe(UserTier.PRO);
      expect(getTierFromPriceId('price_pro_yearly')).toBe(UserTier.PRO);
    });

    it('maps the enterprise price id to ENTERPRISE', () => {
      const { getTierFromPriceId, UserTier } = loadModule();
      expect(getTierFromPriceId('price_enterprise_monthly')).toBe(UserTier.ENTERPRISE);
    });

    it('defaults to FREE for an unrecognized price id', () => {
      const { getTierFromPriceId, UserTier } = loadModule();
      expect(getTierFromPriceId('price_does_not_exist')).toBe(UserTier.FREE);
    });

    it('does not treat an empty/unconfigured price id as a match', () => {
      // With the yearly price unconfigured, an empty lookup must still be FREE
      delete process.env.STRIPE_PRICE_PRO_YEARLY;
      const { getTierFromPriceId, UserTier } = loadModule();
      expect(getTierFromPriceId('')).toBe(UserTier.FREE);
    });
  });

  describe('getPriceIdForTier', () => {
    it('returns the monthly pro price id by default', () => {
      const { getPriceIdForTier } = loadModule();
      expect(getPriceIdForTier('pro')).toBe('price_pro_monthly');
      expect(getPriceIdForTier('pro', 'monthly')).toBe('price_pro_monthly');
    });

    it('returns the yearly pro price id when interval is yearly', () => {
      const { getPriceIdForTier } = loadModule();
      expect(getPriceIdForTier('pro', 'yearly')).toBe('price_pro_yearly');
    });

    it('returns the enterprise monthly price id (enterprise has no yearly)', () => {
      const { getPriceIdForTier } = loadModule();
      expect(getPriceIdForTier('enterprise')).toBe('price_enterprise_monthly');
      expect(getPriceIdForTier('enterprise', 'yearly')).toBe('price_enterprise_monthly');
    });

    it('round-trips tier -> priceId -> tier', () => {
      const { getPriceIdForTier, getTierFromPriceId, UserTier } = loadModule();
      expect(getTierFromPriceId(getPriceIdForTier('pro'))).toBe(UserTier.PRO);
      expect(getTierFromPriceId(getPriceIdForTier('enterprise'))).toBe(UserTier.ENTERPRISE);
    });
  });
});
