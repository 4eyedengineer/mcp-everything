import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';

@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);
  private stripe: Stripe | null = null;

  constructor(private readonly configService: ConfigService) {
    const secretKey = this.configService.get<string>('STRIPE_SECRET_KEY');
    if (secretKey) {
      this.stripe = new Stripe(secretKey);
      this.logger.log('Stripe client initialized');
    } else {
      this.logger.warn('STRIPE_SECRET_KEY not configured - Stripe features will be disabled');
    }
  }

  private ensureStripeConfigured(): Stripe {
    if (!this.stripe) {
      throw new BadRequestException('Stripe is not configured');
    }
    return this.stripe;
  }

  async createCustomer(email: string, metadata?: Record<string, string>): Promise<Stripe.Customer> {
    const stripe = this.ensureStripeConfigured();
    this.logger.log(`Creating Stripe customer for: ${email}`);
    return stripe.customers.create({
      email,
      metadata,
    });
  }

  async getCustomer(customerId: string): Promise<Stripe.Customer | Stripe.DeletedCustomer> {
    const stripe = this.ensureStripeConfigured();
    return stripe.customers.retrieve(customerId);
  }

  async createCheckoutSession(
    customerId: string,
    priceId: string,
    successUrl: string,
    cancelUrl: string,
  ): Promise<Stripe.Checkout.Session> {
    const stripe = this.ensureStripeConfigured();
    this.logger.log(`Creating checkout session for customer: ${customerId}`);
    return stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      subscription_data: {
        metadata: { customerId },
      },
    });
  }

  async createBillingPortalSession(
    customerId: string,
    returnUrl: string,
  ): Promise<Stripe.BillingPortal.Session> {
    const stripe = this.ensureStripeConfigured();
    this.logger.log(`Creating billing portal session for customer: ${customerId}`);
    return stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });
  }

  async getSubscription(subscriptionId: string): Promise<Stripe.Subscription> {
    const stripe = this.ensureStripeConfigured();
    return stripe.subscriptions.retrieve(subscriptionId);
  }

  async cancelSubscription(
    subscriptionId: string,
    immediately = false,
  ): Promise<Stripe.Subscription> {
    const stripe = this.ensureStripeConfigured();
    this.logger.log(`Canceling subscription: ${subscriptionId} (immediately: ${immediately})`);
    if (immediately) {
      return stripe.subscriptions.cancel(subscriptionId);
    }
    return stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: true,
    });
  }

  async resumeSubscription(subscriptionId: string): Promise<Stripe.Subscription> {
    const stripe = this.ensureStripeConfigured();
    this.logger.log(`Resuming subscription: ${subscriptionId}`);
    return stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: false,
    });
  }

  constructWebhookEvent(payload: Buffer, signature: string): Stripe.Event {
    const stripe = this.ensureStripeConfigured();
    const webhookSecret = this.configService.get<string>('STRIPE_WEBHOOK_SECRET');
    if (!webhookSecret) {
      throw new BadRequestException('Webhook secret not configured');
    }
    return stripe.webhooks.constructEvent(payload, signature, webhookSecret);
  }

  isConfigured(): boolean {
    return this.stripe !== null;
  }
}
