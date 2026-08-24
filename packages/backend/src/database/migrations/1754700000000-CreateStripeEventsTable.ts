import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Idempotency ledger for Stripe webhook deliveries.
 *
 * Stripe delivers webhooks at-least-once, so a replayed
 * `invoice.payment_succeeded` would otherwise re-run `resetMonthlyUsage` and
 * grant the user a second month of free quota. The webhook path records each
 * event id here before dispatching and acks-and-skips anything already present.
 *
 * The Stripe event id is the primary key: it provides both the uniqueness
 * guarantee and an atomic insert-if-absent, so two concurrent deliveries of the
 * same event cannot both be processed (one INSERT wins, the other raises a
 * duplicate-key error the webhook path catches and treats as "already seen").
 */
export class CreateStripeEventsTable1754700000000 implements MigrationInterface {
  name = 'CreateStripeEventsTable1754700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "stripe_events" (
        "eventId" varchar(255) PRIMARY KEY,
        "type" varchar(100) NOT NULL,
        "receivedAt" timestamp NOT NULL DEFAULT now()
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "stripe_events"`);
  }
}
