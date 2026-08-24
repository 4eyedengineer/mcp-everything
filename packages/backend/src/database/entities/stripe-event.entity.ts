import { Entity, Column, PrimaryColumn, CreateDateColumn } from 'typeorm';

/**
 * Idempotency ledger for Stripe webhook deliveries.
 *
 * Stripe guarantees *at-least-once* delivery, so the same event id can arrive
 * more than once (retries, network hiccups). Replaying a money-adjacent event
 * such as `invoice.payment_succeeded` would re-run `resetMonthlyUsage` and hand
 * the user a second month of free quota. The webhook path records each event id
 * here before dispatching and skips anything already present.
 *
 * The Stripe event id is the primary key: that gives us a unique constraint and
 * an atomic insert-if-absent, so two concurrent deliveries of the same event
 * cannot both win (one insert succeeds, the other hits a duplicate-key error).
 */
@Entity('stripe_events')
export class StripeEvent {
  /** Stripe event id, e.g. `evt_1abc...`. */
  @PrimaryColumn({ type: 'varchar', length: 255 })
  eventId: string;

  /** Stripe event type, e.g. `invoice.payment_succeeded`. Recorded for audit. */
  @Column({ type: 'varchar', length: 100 })
  type: string;

  @CreateDateColumn()
  receivedAt: Date;
}
