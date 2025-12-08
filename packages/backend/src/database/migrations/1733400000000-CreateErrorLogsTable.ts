import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateErrorLogsTable1733400000000 implements MigrationInterface {
  name = 'CreateErrorLogsTable1733400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Create the error_logs table
    await queryRunner.query(`
      CREATE TABLE "error_logs" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "timestamp" TIMESTAMP NOT NULL,
        "level" varchar(50) NOT NULL,
        "message" varchar(500) NOT NULL,
        "stack" text,
        "service" varchar(255),
        "method" varchar(255),
        "conversationId" uuid,
        "userId" uuid,
        "context" jsonb,
        "errorCode" varchar(100),
        "resolved" boolean NOT NULL DEFAULT false,
        "resolution" text,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now()
      )
    `);

    // Create indexes for efficient querying
    await queryRunner.query(`
      CREATE INDEX "IDX_error_logs_timestamp" ON "error_logs" ("timestamp")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_error_logs_level" ON "error_logs" ("level")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_error_logs_service" ON "error_logs" ("service")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_error_logs_conversationId" ON "error_logs" ("conversationId")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_error_logs_userId" ON "error_logs" ("userId")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_error_logs_errorCode" ON "error_logs" ("errorCode")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_error_logs_resolved" ON "error_logs" ("resolved")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_error_logs_resolved"`);
    await queryRunner.query(`DROP INDEX "IDX_error_logs_errorCode"`);
    await queryRunner.query(`DROP INDEX "IDX_error_logs_userId"`);
    await queryRunner.query(`DROP INDEX "IDX_error_logs_conversationId"`);
    await queryRunner.query(`DROP INDEX "IDX_error_logs_service"`);
    await queryRunner.query(`DROP INDEX "IDX_error_logs_level"`);
    await queryRunner.query(`DROP INDEX "IDX_error_logs_timestamp"`);
    await queryRunner.query(`DROP TABLE "error_logs"`);
  }
}
