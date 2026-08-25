import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Subscription } from '../database/entities/subscription.entity';
import { StripeEvent } from '../database/entities/stripe-event.entity';
import { UserService } from '../user/user.service';
import { StripeService } from './stripe.service';
import { UserTier, getTierFromPriceId, getPriceIdForTier } from './tier-config';

// Postgres unique-violation SQLSTATE - raised when a duplicate webhook delivery
// races to insert the same event id into the idempotency ledger.
const PG_UNIQUE_VIOLATION = '23505';

// Stripe webhook event types - using narrow shapes for the fields we read.
// NB: under the pinned API version the billing period lives on the subscription
// *item*, not the Subscription object, so it is read from `items.data[]`.
interface StripeSubscriptionItemData {
  price: { id: string };
  current_period_start?: number;
  current_period_end?: number;
}

interface StripeSubscriptionData {
  id: string;
  customer: string;
  cancel_at_period_end: boolean;
  status: string;
  items: {
    data: StripeSubscriptionItemData[];
  };
}

interface StripeInvoiceData {
  id: string;
  subscription: string | null;
}

interface StripeCheckoutSessionData {
  id: string;
  subscription: string | null;
  customer: string | null;
}

@Injectable()
export class SubscriptionService {
  private readonly logger = new Logger(SubscriptionService.name);

  constructor(
    @InjectRepository(Subscription)
    private readonly subscriptionRepository: Repository<Subscription>,
    @InjectRepository(StripeEvent)
    private readonly stripeEventRepository: Repository<StripeEvent>,
    private readonly userService: UserService,
    private readonly stripeService: StripeService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Record a webhook event in the idempotency ledger.
   *
   * Returns `true` when this is the first time we have seen the event id (the
   * caller should process it) and `false` when it has already been recorded (a
   * duplicate at-least-once delivery, which the caller must ack-and-skip).
   *
   * Concurrency-safe: the ledger's primary key is the event id, so of two
   * racing deliveries exactly one INSERT succeeds; the loser raises a
   * unique-violation which we translate into "already processed".
   */
  async recordWebhookEvent(eventId: string, type: string): Promise<boolean> {
    try {
      await this.stripeEventRepository.insert({ eventId, type });
      return true;
    } catch (error) {
      if (
        error instanceof QueryFailedError &&
        (error as { code?: string }).code === PG_UNIQUE_VIOLATION
      ) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Extract the current billing period from a Stripe subscription.
   *
   * Under the pinned API version these fields live on the first subscription
   * item, not the Subscription object. Anything missing/non-numeric yields
   * `null` so we never persist an Invalid Date.
   */
  private extractCurrentPeriod(stripeSubscription: StripeSubscriptionData): {
    start: Date | null;
    end: Date | null;
  } {
    const item = stripeSubscription.items?.data?.[0];
    const start =
      typeof item?.current_period_start === 'number'
        ? new Date(item.current_period_start * 1000)
        : null;
    const end =
      typeof item?.current_period_end === 'number'
        ? new Date(item.current_period_end * 1000)
        : null;
    return { start, end };
  }

  async getActiveSubscription(userId: string): Promise<Subscription | null> {
    return this.subscriptionRepository.findOne({
      where: { userId, status: 'active' },
      order: { createdAt: 'DESC' },
    });
  }

  async getSubscriptionByStripeId(stripeSubscriptionId: string): Promise<Subscription | null> {
    return this.subscriptionRepository.findOne({
      where: { stripeSubscriptionId },
    });
  }

  async getSubscriptionByCustomerId(stripeCustomerId: string): Promise<Subscription | null> {
    return this.subscriptionRepository.findOne({
      where: { stripeCustomerId },
      order: { createdAt: 'DESC' },
    });
  }

  async createCheckoutSession(
    userId: string,
    tier: 'pro' | 'enterprise',
    interval: 'monthly' | 'yearly' = 'monthly',
  ): Promise<{ sessionId: string; url: string }> {
    if (!this.stripeService.isConfigured()) {
      throw new BadRequestException('Stripe is not configured');
    }

    const user = await this.userService.findById(userId);
    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Get or create Stripe customer
    let subscription = await this.getActiveSubscription(userId);
    let customerId = subscription?.stripeCustomerId;

    if (!customerId) {
      const customer = await this.stripeService.createCustomer(user.email, { userId });
      customerId = customer.id;

      // Create subscription record with customer ID
      subscription = this.subscriptionRepository.create({
        userId,
        stripeCustomerId: customerId,
        tier: UserTier.FREE,
        status: 'incomplete',
      });
      await this.subscriptionRepository.save(subscription);
    }

    // Get price ID based on tier and interval
    const priceId = getPriceIdForTier(tier, interval);

    const frontendUrl = this.configService.get<string>('FRONTEND_URL') || 'http://localhost:4200';
    const session = await this.stripeService.createCheckoutSession(
      customerId,
      priceId,
      `${frontendUrl}/account?session_id={CHECKOUT_SESSION_ID}&success=true`,
      `${frontendUrl}/account?canceled=true`,
    );

    this.logger.log(`Created checkout session for user ${userId}: ${session.id}`);
    return { sessionId: session.id, url: session.url! };
  }

  async createPortalSession(userId: string): Promise<{ url: string }> {
    if (!this.stripeService.isConfigured()) {
      throw new BadRequestException('Stripe is not configured');
    }

    const subscription = await this.getActiveSubscription(userId);
    if (!subscription?.stripeCustomerId) {
      throw new NotFoundException('No active subscription found');
    }

    const frontendUrl = this.configService.get<string>('FRONTEND_URL') || 'http://localhost:4200';
    const session = await this.stripeService.createBillingPortalSession(
      subscription.stripeCustomerId,
      `${frontendUrl}/account`,
    );

    this.logger.log(`Created portal session for user ${userId}`);
    return { url: session.url };
  }

  async handleSubscriptionCreated(stripeSubscription: StripeSubscriptionData): Promise<void> {
    this.logger.log(`Handling subscription created: ${stripeSubscription.id}`);

    const customerId = stripeSubscription.customer as string;
    const subscription = await this.getSubscriptionByCustomerId(customerId);

    if (!subscription) {
      this.logger.warn(`No subscription record found for customer: ${customerId}`);
      return;
    }

    // Determine tier from price ID
    const priceId = stripeSubscription.items.data[0]?.price.id;
    const tier = getTierFromPriceId(priceId);

    // Update subscription
    subscription.stripeSubscriptionId = stripeSubscription.id;
    subscription.stripePriceId = priceId;
    const period = this.extractCurrentPeriod(stripeSubscription);
    subscription.tier = tier;
    subscription.status = 'active';
    subscription.currentPeriodStart = period.start;
    subscription.currentPeriodEnd = period.end;
    subscription.cancelAtPeriodEnd = stripeSubscription.cancel_at_period_end;
    await this.subscriptionRepository.save(subscription);

    // Update user tier
    await this.userService.updateTier(subscription.userId, tier);
    this.logger.log(`Subscription created: user=${subscription.userId}, tier=${tier}`);
  }

  /**
   * Reconcile from `checkout.session.completed`.
   *
   * `customer.subscription.created` is what normally flips the tier, but Stripe
   * can drop or delay it. `checkout.session.completed` fires on the same
   * successful checkout and carries the new subscription id, so we fetch the
   * live subscription and run it through the same create path - a backfill for
   * the missed-webhook case. No-op when Stripe is unconfigured or the session
   * carries no subscription (e.g. one-off payments).
   */
  async handleCheckoutSessionCompleted(session: StripeCheckoutSessionData): Promise<void> {
    if (!this.stripeService.isConfigured()) return;
    if (!session.subscription) {
      this.logger.log(`Checkout session ${session.id} has no subscription - nothing to reconcile`);
      return;
    }

    const stripeSubscription = await this.stripeService.getSubscription(session.subscription);
    await this.handleSubscriptionCreated(stripeSubscription as unknown as StripeSubscriptionData);
    this.logger.log(
      `Reconciled subscription ${session.subscription} from checkout session ${session.id}`,
    );
  }

  async handleSubscriptionUpdated(stripeSubscription: StripeSubscriptionData): Promise<void> {
    this.logger.log(`Handling subscription updated: ${stripeSubscription.id}`);

    const subscription = await this.getSubscriptionByStripeId(stripeSubscription.id);
    if (!subscription) {
      this.logger.warn(`No subscription found: ${stripeSubscription.id}`);
      return;
    }

    const priceId = stripeSubscription.items.data[0]?.price.id;
    const tier = getTierFromPriceId(priceId);

    const period = this.extractCurrentPeriod(stripeSubscription);
    subscription.tier = tier;
    subscription.status = this.mapStripeStatus(stripeSubscription.status);
    subscription.currentPeriodStart = period.start;
    subscription.currentPeriodEnd = period.end;
    subscription.cancelAtPeriodEnd = stripeSubscription.cancel_at_period_end;
    await this.subscriptionRepository.save(subscription);

    // Update user tier if subscription is active
    if (subscription.status === 'active') {
      await this.userService.updateTier(subscription.userId, tier);
    }

    this.logger.log(
      `Subscription updated: user=${subscription.userId}, tier=${tier}, status=${subscription.status}`,
    );
  }

  async handleSubscriptionDeleted(stripeSubscription: StripeSubscriptionData): Promise<void> {
    this.logger.log(`Handling subscription deleted: ${stripeSubscription.id}`);

    const subscription = await this.getSubscriptionByStripeId(stripeSubscription.id);
    if (!subscription) {
      this.logger.warn(`No subscription found for deletion: ${stripeSubscription.id}`);
      return;
    }

    subscription.status = 'canceled';
    subscription.canceledAt = new Date();
    await this.subscriptionRepository.save(subscription);

    // Downgrade user to free tier
    await this.userService.updateTier(subscription.userId, UserTier.FREE);
    this.logger.log(`Subscription deleted: user=${subscription.userId} downgraded to free`);
  }

  async handleInvoicePaymentSucceeded(invoice: StripeInvoiceData): Promise<void> {
    if (!invoice.subscription) return;

    this.logger.log(`Handling invoice payment succeeded: ${invoice.id}`);

    const subscription = await this.getSubscriptionByStripeId(invoice.subscription as string);
    if (subscription) {
      // Reset monthly usage on successful payment (new billing period)
      await this.userService.resetMonthlyUsage(subscription.userId);
      this.logger.log(`Reset usage for user ${subscription.userId} after successful payment`);
    }
  }

  async handleInvoicePaymentFailed(invoice: StripeInvoiceData): Promise<void> {
    if (!invoice.subscription) return;

    this.logger.warn(`Invoice payment failed: ${invoice.id}`);

    const subscription = await this.getSubscriptionByStripeId(invoice.subscription as string);
    if (subscription) {
      subscription.status = 'past_due';
      await this.subscriptionRepository.save(subscription);
      this.logger.warn(`Subscription ${subscription.id} marked as past_due`);
    }
  }

  private mapStripeStatus(
    status: string,
  ): 'active' | 'canceled' | 'past_due' | 'incomplete' | 'trialing' {
    const statusMap: Record<
      string,
      'active' | 'canceled' | 'past_due' | 'incomplete' | 'trialing'
    > = {
      active: 'active',
      canceled: 'canceled',
      past_due: 'past_due',
      incomplete: 'incomplete',
      trialing: 'trialing',
      incomplete_expired: 'canceled',
      unpaid: 'past_due',
      paused: 'canceled',
    };
    return statusMap[status] || 'active';
  }
}
