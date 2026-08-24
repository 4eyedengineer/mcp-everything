/// <reference types="jest" />
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { StripeWebhookController } from './stripe-webhook.controller';
import { StripeService } from './stripe.service';
import { SubscriptionService } from './subscription.service';

/**
 * The webhook controller is the idempotency gate. Stripe delivers at-least-once,
 * so a replayed event id must be acked with 200 and skipped BEFORE any handler
 * runs - otherwise a duplicate `invoice.payment_succeeded` would reset usage a
 * second time and hand the user free quota.
 */
describe('StripeWebhookController', () => {
  let controller: StripeWebhookController;
  let stripeService: any;
  let subscriptionService: any;

  const rawBody = Buffer.from('{}');
  const req: any = { rawBody };

  function invoiceEvent() {
    return {
      id: 'evt_dup',
      type: 'invoice.payment_succeeded',
      data: { object: { id: 'in_1', subscription: 'sub_123' } },
    };
  }

  beforeEach(async () => {
    stripeService = { constructWebhookEvent: jest.fn() };
    subscriptionService = {
      recordWebhookEvent: jest.fn(),
      handleInvoicePaymentSucceeded: jest.fn().mockResolvedValue(undefined),
      handleCheckoutSessionCompleted: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [StripeWebhookController],
      providers: [
        { provide: StripeService, useValue: stripeService },
        { provide: SubscriptionService, useValue: subscriptionService },
      ],
    }).compile();

    controller = module.get(StripeWebhookController);
  });

  it('rejects a request with no signature header', async () => {
    await expect(controller.handleWebhook(undefined as any, req)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('processes a first-seen event and dispatches to the handler', async () => {
    stripeService.constructWebhookEvent.mockReturnValue(invoiceEvent());
    subscriptionService.recordWebhookEvent.mockResolvedValue(true);

    const result = await controller.handleWebhook('sig', req);

    expect(subscriptionService.recordWebhookEvent).toHaveBeenCalledWith(
      'evt_dup',
      'invoice.payment_succeeded',
    );
    expect(subscriptionService.handleInvoicePaymentSucceeded).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ received: true });
  });

  it('acks and SKIPS a replayed event without running the handler (no double usage reset)', async () => {
    stripeService.constructWebhookEvent.mockReturnValue(invoiceEvent());
    subscriptionService.recordWebhookEvent.mockResolvedValue(false);

    const result = await controller.handleWebhook('sig', req);

    expect(result).toEqual({ received: true });
    expect(subscriptionService.handleInvoicePaymentSucceeded).not.toHaveBeenCalled();
  });

  it('still returns 200 when a handler throws (Stripe should not retry a processing error)', async () => {
    stripeService.constructWebhookEvent.mockReturnValue(invoiceEvent());
    subscriptionService.recordWebhookEvent.mockResolvedValue(true);
    subscriptionService.handleInvoicePaymentSucceeded.mockRejectedValue(new Error('boom'));

    const result = await controller.handleWebhook('sig', req);
    expect(result).toEqual({ received: true });
  });
});
