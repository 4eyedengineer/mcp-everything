/// <reference types="jest" />
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { SubscriptionService } from './subscription.service';
import { Subscription } from '../database/entities/subscription.entity';
import { StripeEvent } from '../database/entities/stripe-event.entity';
import { UserService } from '../user/user.service';
import { StripeService } from './stripe.service';
import { UserTier } from './tier-config';

// Control tier resolution so handler assertions don't depend on env price ids.
jest.mock('./tier-config', () => {
  const actual = jest.requireActual('./tier-config');
  return { ...actual, getTierFromPriceId: jest.fn() };
});
// eslint-disable-next-line @typescript-eslint/no-var-requires
import { getTierFromPriceId } from './tier-config';
const getTierFromPriceIdMock = getTierFromPriceId as jest.Mock;

/** Build a Stripe-subscription-like object with the period on the *item*. */
function makeStripeSubscription(overrides: any = {}) {
  return {
    id: 'sub_123',
    customer: 'cus_123',
    cancel_at_period_end: false,
    status: 'active',
    items: {
      data: [
        {
          price: { id: 'price_pro_monthly' },
          current_period_start: 1_700_000_000,
          current_period_end: 1_702_600_000,
        },
      ],
    },
    ...overrides,
  };
}

describe('SubscriptionService', () => {
  let service: SubscriptionService;
  let subscriptionRepo: any;
  let stripeEventRepo: any;
  let userService: any;
  let stripeService: any;

  beforeEach(async () => {
    getTierFromPriceIdMock.mockReset();
    getTierFromPriceIdMock.mockReturnValue(UserTier.PRO);

    subscriptionRepo = {
      findOne: jest.fn(),
      save: jest.fn((s) => Promise.resolve(s)),
      create: jest.fn((v) => v),
    };
    stripeEventRepo = {
      insert: jest.fn().mockResolvedValue(undefined),
    };
    userService = {
      updateTier: jest.fn().mockResolvedValue(undefined),
      resetMonthlyUsage: jest.fn().mockResolvedValue(undefined),
      findById: jest.fn(),
    };
    stripeService = {
      isConfigured: jest.fn().mockReturnValue(true),
      getSubscription: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SubscriptionService,
        { provide: getRepositoryToken(Subscription), useValue: subscriptionRepo },
        { provide: getRepositoryToken(StripeEvent), useValue: stripeEventRepo },
        { provide: UserService, useValue: userService },
        { provide: StripeService, useValue: stripeService },
        { provide: ConfigService, useValue: { get: jest.fn() } },
      ],
    }).compile();

    service = module.get(SubscriptionService);
  });

  describe('recordWebhookEvent (idempotency ledger)', () => {
    it('returns true the first time an event id is recorded', async () => {
      stripeEventRepo.insert.mockResolvedValue(undefined);
      await expect(service.recordWebhookEvent('evt_1', 'invoice.payment_succeeded')).resolves.toBe(
        true,
      );
      expect(stripeEventRepo.insert).toHaveBeenCalledWith({
        eventId: 'evt_1',
        type: 'invoice.payment_succeeded',
      });
    });

    it('returns false (already processed) on a duplicate-key violation from a racing delivery', async () => {
      const dup = new QueryFailedError(
        'INSERT',
        [],
        Object.assign(new Error('duplicate key'), { code: '23505' }),
      );
      stripeEventRepo.insert.mockRejectedValue(dup);
      await expect(service.recordWebhookEvent('evt_1', 'x')).resolves.toBe(false);
    });

    it('rethrows unexpected database errors instead of masking them as duplicates', async () => {
      const other = new QueryFailedError(
        'INSERT',
        [],
        Object.assign(new Error('connection lost'), { code: '08006' }),
      );
      stripeEventRepo.insert.mockRejectedValue(other);
      await expect(service.recordWebhookEvent('evt_1', 'x')).rejects.toBe(other);
    });
  });

  describe('handleSubscriptionCreated', () => {
    it('activates the subscription, reads the period from items[], and flips the tier', async () => {
      const sub: any = { id: 'row-1', userId: 'user-1', stripeCustomerId: 'cus_123' };
      subscriptionRepo.findOne.mockResolvedValue(sub);

      await service.handleSubscriptionCreated(makeStripeSubscription());

      expect(sub.status).toBe('active');
      expect(sub.tier).toBe(UserTier.PRO);
      expect(sub.stripeSubscriptionId).toBe('sub_123');
      expect(sub.currentPeriodStart).toEqual(new Date(1_700_000_000 * 1000));
      expect(sub.currentPeriodEnd).toEqual(new Date(1_702_600_000 * 1000));
      expect(subscriptionRepo.save).toHaveBeenCalledWith(sub);
      expect(userService.updateTier).toHaveBeenCalledWith('user-1', UserTier.PRO);
    });

    it('stores null (never Invalid Date) when the item carries no period', async () => {
      const sub: any = { id: 'row-1', userId: 'user-1', stripeCustomerId: 'cus_123' };
      subscriptionRepo.findOne.mockResolvedValue(sub);

      await service.handleSubscriptionCreated(
        makeStripeSubscription({ items: { data: [{ price: { id: 'price_pro_monthly' } }] } }),
      );

      expect(sub.currentPeriodStart).toBeNull();
      expect(sub.currentPeriodEnd).toBeNull();
    });

    it('no-ops when no local subscription row matches the customer', async () => {
      subscriptionRepo.findOne.mockResolvedValue(null);
      await service.handleSubscriptionCreated(makeStripeSubscription());
      expect(subscriptionRepo.save).not.toHaveBeenCalled();
      expect(userService.updateTier).not.toHaveBeenCalled();
    });
  });

  describe('handleSubscriptionUpdated', () => {
    it('maps status, refreshes the period, and updates tier while active', async () => {
      const sub: any = { id: 'row-1', userId: 'user-1', stripeSubscriptionId: 'sub_123' };
      subscriptionRepo.findOne.mockResolvedValue(sub);

      await service.handleSubscriptionUpdated(makeStripeSubscription({ status: 'active' }));

      expect(sub.status).toBe('active');
      expect(sub.currentPeriodStart).toEqual(new Date(1_700_000_000 * 1000));
      expect(userService.updateTier).toHaveBeenCalledWith('user-1', UserTier.PRO);
    });

    it('does not flip tier when the mapped status is not active', async () => {
      const sub: any = { id: 'row-1', userId: 'user-1', stripeSubscriptionId: 'sub_123' };
      subscriptionRepo.findOne.mockResolvedValue(sub);

      await service.handleSubscriptionUpdated(makeStripeSubscription({ status: 'past_due' }));

      expect(sub.status).toBe('past_due');
      expect(userService.updateTier).not.toHaveBeenCalled();
    });
  });

  describe('handleSubscriptionDeleted', () => {
    it('cancels the row and downgrades the user to free', async () => {
      const sub: any = { id: 'row-1', userId: 'user-1', stripeSubscriptionId: 'sub_123' };
      subscriptionRepo.findOne.mockResolvedValue(sub);

      await service.handleSubscriptionDeleted(makeStripeSubscription());

      expect(sub.status).toBe('canceled');
      expect(sub.canceledAt).toBeInstanceOf(Date);
      expect(userService.updateTier).toHaveBeenCalledWith('user-1', UserTier.FREE);
    });
  });

  describe('handleInvoicePaymentSucceeded', () => {
    it('resets monthly usage for the subscription owner', async () => {
      subscriptionRepo.findOne.mockResolvedValue({ id: 'row-1', userId: 'user-1' });
      await service.handleInvoicePaymentSucceeded({ id: 'in_1', subscription: 'sub_123' });
      expect(userService.resetMonthlyUsage).toHaveBeenCalledWith('user-1');
    });

    it('ignores invoices with no subscription', async () => {
      await service.handleInvoicePaymentSucceeded({ id: 'in_1', subscription: null });
      expect(userService.resetMonthlyUsage).not.toHaveBeenCalled();
    });
  });

  describe('handleInvoicePaymentFailed', () => {
    it('marks the subscription past_due without touching usage', async () => {
      const sub: any = { id: 'row-1', userId: 'user-1', status: 'active' };
      subscriptionRepo.findOne.mockResolvedValue(sub);

      await service.handleInvoicePaymentFailed({ id: 'in_1', subscription: 'sub_123' });

      expect(sub.status).toBe('past_due');
      expect(subscriptionRepo.save).toHaveBeenCalledWith(sub);
      expect(userService.resetMonthlyUsage).not.toHaveBeenCalled();
    });
  });

  describe('handleCheckoutSessionCompleted (missed-webhook reconciliation)', () => {
    it('fetches the live subscription and runs it through the create path', async () => {
      const sub: any = { id: 'row-1', userId: 'user-1', stripeCustomerId: 'cus_123' };
      subscriptionRepo.findOne.mockResolvedValue(sub);
      stripeService.getSubscription.mockResolvedValue(makeStripeSubscription());

      await service.handleCheckoutSessionCompleted({
        id: 'cs_1',
        subscription: 'sub_123',
        customer: 'cus_123',
      });

      expect(stripeService.getSubscription).toHaveBeenCalledWith('sub_123');
      expect(userService.updateTier).toHaveBeenCalledWith('user-1', UserTier.PRO);
    });

    it('no-ops when the session carries no subscription', async () => {
      await service.handleCheckoutSessionCompleted({
        id: 'cs_1',
        subscription: null,
        customer: 'cus_123',
      });
      expect(stripeService.getSubscription).not.toHaveBeenCalled();
    });

    it('no-ops when Stripe is not configured', async () => {
      stripeService.isConfigured.mockReturnValue(false);
      await service.handleCheckoutSessionCompleted({
        id: 'cs_1',
        subscription: 'sub_123',
        customer: 'cus_123',
      });
      expect(stripeService.getSubscription).not.toHaveBeenCalled();
    });
  });
});
