import {
  Controller,
  Post,
  Headers,
  Req,
  HttpCode,
  Logger,
  BadRequestException,
  RawBodyRequest,
} from '@nestjs/common';
import { Request } from 'express';
import { StripeService } from './stripe.service';
import { SubscriptionService } from './subscription.service';

@Controller('api/webhooks/stripe')
export class StripeWebhookController {
  private readonly logger = new Logger(StripeWebhookController.name);

  constructor(
    private readonly stripeService: StripeService,
    private readonly subscriptionService: SubscriptionService,
  ) {}

  @Post()
  @HttpCode(200)
  async handleWebhook(
    @Headers('stripe-signature') signature: string,
    @Req() req: RawBodyRequest<Request>,
  ): Promise<{ received: boolean }> {
    if (!signature) {
      throw new BadRequestException('Missing stripe-signature header');
    }

    if (!req.rawBody) {
      throw new BadRequestException('Missing raw body - ensure raw body parsing is enabled');
    }

    let event: any;

    try {
      event = this.stripeService.constructWebhookEvent(req.rawBody, signature);
    } catch (err) {
      this.logger.error(`Webhook signature verification failed: ${(err as Error).message}`);
      throw new BadRequestException(`Webhook signature verification failed: ${(err as Error).message}`);
    }

    this.logger.log(`Processing webhook event: ${event.type} (${event.id})`);

    try {
      switch (event.type) {
        case 'customer.subscription.created':
          await this.subscriptionService.handleSubscriptionCreated(event.data.object);
          break;

        case 'customer.subscription.updated':
          await this.subscriptionService.handleSubscriptionUpdated(event.data.object);
          break;

        case 'customer.subscription.deleted':
          await this.subscriptionService.handleSubscriptionDeleted(event.data.object);
          break;

        case 'invoice.payment_succeeded':
          await this.subscriptionService.handleInvoicePaymentSucceeded(event.data.object);
          break;

        case 'invoice.payment_failed':
          await this.subscriptionService.handleInvoicePaymentFailed(event.data.object);
          break;

        case 'checkout.session.completed':
          this.logger.log(`Checkout session completed: ${event.data.object.id}`);
          // Subscription handling is done via subscription.created webhook
          break;

        default:
          this.logger.log(`Unhandled event type: ${event.type}`);
      }
    } catch (error) {
      this.logger.error(`Error processing webhook ${event.type}: ${(error as Error).message}`, (error as Error).stack);
      // Don't throw - return 200 to acknowledge receipt
      // Stripe will retry on errors, so we want to prevent infinite retries for processing errors
    }

    return { received: true };
  }
}
