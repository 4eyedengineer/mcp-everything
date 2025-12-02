import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateDeploymentsTable1704000000002 implements MigrationInterface {
  name = 'CreateDeploymentsTable1704000000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "deployments" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "conversationId" uuid NOT NULL,
        "deploymentType" varchar(20) NOT NULL,
        "repositoryUrl" text,
        "gistUrl" text,
        "codespaceUrl" text,
        "status" varchar(20) NOT NULL DEFAULT 'pending',
        "errorMessage" text,
        "metadata" jsonb,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "deployedAt" TIMESTAMP,
        CONSTRAINT "FK_deployments_conversation"
          FOREIGN KEY ("conversationId")
          REFERENCES "conversations"("id")
          ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_deployments_conversationId" ON "deployments" ("conversationId")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_deployments_status" ON "deployments" ("status")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_deployments_status"`);
    await queryRunner.query(`DROP INDEX "IDX_deployments_conversationId"`);
    await queryRunner.query(`DROP TABLE "deployments"`);
  }
}
