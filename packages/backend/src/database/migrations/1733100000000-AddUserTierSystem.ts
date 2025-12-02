import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUserTierSystem1733100000000 implements MigrationInterface {
  name = 'AddUserTierSystem1733100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Enable UUID extension if not exists
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    // Create users table
    await queryRunner.query(`
      CREATE TABLE "users" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "email" varchar(255) UNIQUE NOT NULL,
        "passwordHash" varchar(255),
        "firstName" varchar(100),
        "lastName" varchar(100),
        "githubUsername" varchar(100),
        "githubId" varchar(255),
        "googleId" varchar(255),
        "isActive" boolean DEFAULT true,
        "isEmailVerified" boolean DEFAULT false,
        "tier" varchar(20) DEFAULT 'free',
        "lastLoginAt" timestamp,
        "createdAt" timestamp DEFAULT now(),
        "updatedAt" timestamp DEFAULT now()
      )
    `);

    // Create subscriptions table
    await queryRunner.query(`
      CREATE TABLE "subscriptions" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "userId" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "stripeCustomerId" varchar(255) NOT NULL,
        "stripeSubscriptionId" varchar(255),
        "stripePriceId" varchar(255),
        "tier" varchar(20) DEFAULT 'free',
        "status" varchar(20) DEFAULT 'active',
        "currentPeriodStart" timestamp,
        "currentPeriodEnd" timestamp,
        "cancelAtPeriodEnd" boolean DEFAULT false,
        "canceledAt" timestamp,
        "createdAt" timestamp DEFAULT now(),
        "updatedAt" timestamp DEFAULT now()
      )
    `);

    // Create usage_records table
    await queryRunner.query(`
      CREATE TABLE "usage_records" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "userId" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "serversDeployedThisMonth" int DEFAULT 0,
        "monthlyLimit" int DEFAULT 5,
        "periodStart" timestamp NOT NULL,
        "periodEnd" timestamp NOT NULL,
        "createdAt" timestamp DEFAULT now(),
        "updatedAt" timestamp DEFAULT now()
      )
    `);

    // Add userId and userTier columns to deployments table
    await queryRunner.query(`ALTER TABLE "deployments" ADD COLUMN "userId" uuid REFERENCES "users"("id") ON DELETE SET NULL`);
    await queryRunner.query(`ALTER TABLE "deployments" ADD COLUMN "userTier" varchar(20)`);

    // Add userId column to conversations table
    await queryRunner.query(`ALTER TABLE "conversations" ADD COLUMN "userId" uuid REFERENCES "users"("id") ON DELETE SET NULL`);

    // Create indexes for users table
    await queryRunner.query(`CREATE INDEX "IDX_users_email" ON "users"("email")`);
    await queryRunner.query(`CREATE INDEX "IDX_users_tier" ON "users"("tier")`);
    await queryRunner.query(`CREATE INDEX "IDX_users_githubId" ON "users"("githubId")`);
    await queryRunner.query(`CREATE INDEX "IDX_users_googleId" ON "users"("googleId")`);

    // Create indexes for subscriptions table
    await queryRunner.query(`CREATE INDEX "IDX_subscriptions_userId" ON "subscriptions"("userId")`);
    await queryRunner.query(`CREATE INDEX "IDX_subscriptions_status" ON "subscriptions"("status")`);
    await queryRunner.query(`CREATE INDEX "IDX_subscriptions_stripeCustomerId" ON "subscriptions"("stripeCustomerId")`);
    await queryRunner.query(`CREATE INDEX "IDX_subscriptions_stripeSubscriptionId" ON "subscriptions"("stripeSubscriptionId")`);

    // Create indexes for usage_records table
    await queryRunner.query(`CREATE INDEX "IDX_usage_userId" ON "usage_records"("userId")`);
    await queryRunner.query(`CREATE INDEX "IDX_usage_periodStart" ON "usage_records"("periodStart")`);
    await queryRunner.query(`CREATE INDEX "IDX_usage_periodEnd" ON "usage_records"("periodEnd")`);

    // Create indexes for new columns on existing tables
    await queryRunner.query(`CREATE INDEX "IDX_deployments_userId" ON "deployments"("userId")`);
    await queryRunner.query(`CREATE INDEX "IDX_conversations_userId" ON "conversations"("userId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop indexes for new columns on existing tables
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_conversations_userId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_deployments_userId"`);

    // Drop indexes for usage_records table
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_usage_periodEnd"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_usage_periodStart"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_usage_userId"`);

    // Drop indexes for subscriptions table
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_subscriptions_stripeSubscriptionId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_subscriptions_stripeCustomerId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_subscriptions_status"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_subscriptions_userId"`);

    // Drop indexes for users table
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_users_googleId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_users_githubId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_users_tier"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_users_email"`);

    // Drop columns from existing tables
    await queryRunner.query(`ALTER TABLE "conversations" DROP COLUMN IF EXISTS "userId"`);
    await queryRunner.query(`ALTER TABLE "deployments" DROP COLUMN IF EXISTS "userTier"`);
    await queryRunner.query(`ALTER TABLE "deployments" DROP COLUMN IF EXISTS "userId"`);

    // Drop new tables
    await queryRunner.query(`DROP TABLE IF EXISTS "usage_records"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "subscriptions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "users"`);
  }
}
