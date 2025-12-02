import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Subscription } from '../database/entities/subscription.entity';
import { UserService } from '../user/user.service';
import { StripeService } from './stripe.service';
import { UserTier, STRIPE_PRICES, getTierFromPriceId } from './tier-config';

// Stripe webhook event types - using any for flexibility with Stripe API changes
interface StripeSubscriptionData {
  id: string;
  customer: string;
  current_period_start: number;
  current_period_end: number;
  cancel_at_period_end: boolean;
  status: string;
  items: {
    data: Array<{
      price: { id: string };
    }>;
  };
}

interface StripeInvoiceData {
  id: string;
  subscription: string | null;
}

@Injectable()
export class SubscriptionService {
  private readonly logger = new Logger(SubscriptionService.name);

  constructor(
    @InjectRepository(Subscription)
    private readonly subscriptionRepository: Repository<Subscription>,
    private readonly userService: UserService,
    private readonly stripeService: StripeService,
    private readonly configService: ConfigService,
  ) {}

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
    let priceId: string;
    if (tier === 'pro') {
      priceId = interval === 'yearly' ? STRIPE_PRICES.PRO_YEARLY.priceId : STRIPE_PRICES.PRO_MONTHLY.priceId;
    } else {
      priceId = STRIPE_PRICES.ENTERPRISE_MONTHLY.priceId;
    }

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
    let subscription = await this.getSubscriptionByCustomerId(customerId);

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
    subscription.tier = tier;
    subscription.status = 'active';
    subscription.currentPeriodStart = new Date(stripeSubscription.current_period_start * 1000);
    subscription.currentPeriodEnd = new Date(stripeSubscription.current_period_end * 1000);
    subscription.cancelAtPeriodEnd = stripeSubscription.cancel_at_period_end;
    await this.subscriptionRepository.save(subscription);

    // Update user tier
    await this.userService.updateTier(subscription.userId, tier);
    this.logger.log(`Subscription created: user=${subscription.userId}, tier=${tier}`);
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

    subscription.tier = tier;
    subscription.status = this.mapStripeStatus(stripeSubscription.status);
    subscription.currentPeriodStart = new Date(stripeSubscription.current_period_start * 1000);
    subscription.currentPeriodEnd = new Date(stripeSubscription.current_period_end * 1000);
    subscription.cancelAtPeriodEnd = stripeSubscription.cancel_at_period_end;
    await this.subscriptionRepository.save(subscription);

    // Update user tier if subscription is active
    if (subscription.status === 'active') {
      await this.userService.updateTier(subscription.userId, tier);
    }

    this.logger.log(`Subscription updated: user=${subscription.userId}, tier=${tier}, status=${subscription.status}`);
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

  private mapStripeStatus(status: string): 'active' | 'canceled' | 'past_due' | 'incomplete' | 'trialing' {
    const statusMap: Record<string, 'active' | 'canceled' | 'past_due' | 'incomplete' | 'trialing'> = {
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
