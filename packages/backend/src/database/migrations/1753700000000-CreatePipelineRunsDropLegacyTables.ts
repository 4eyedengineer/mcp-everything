import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 2 backend collapse.
 *
 * - Creates `pipeline_runs`: one row per generation-pipeline step, replacing the
 *   write-only LangGraph checkpoints in `conversation_memories`.
 * - Drops `conversation_memories` (nothing ever read it back) and
 *   `research_cache` (never wired up - ResearchService's cache lookup was
 *   permanently commented out).
 *
 * The original CreateConversationTables / CreateResearchCacheTable migrations
 * are intentionally kept so historical migration state still replays.
 */
export class CreatePipelineRunsDropLegacyTables1753700000000 implements MigrationInterface {
  name = 'CreatePipelineRunsDropLegacyTables1753700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "pipeline_runs" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "conversationId" uuid NOT NULL,
        "step" varchar(64) NOT NULL,
        "status" varchar(16) NOT NULL,
        "startedAt" TIMESTAMP NOT NULL,
        "finishedAt" TIMESTAMP,
        "durationMs" integer,
        "inputSummary" text,
        "outputSummary" text,
        "error" text,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "FK_pipeline_runs_conversation"
          FOREIGN KEY ("conversationId")
          REFERENCES "conversations"("id")
          ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_pipeline_runs_conversationId"
      ON "pipeline_runs" ("conversationId")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_pipeline_runs_step" ON "pipeline_runs" ("step")
    `);

    // Legacy tables - no reader has ever existed for either.
    await queryRunner.query(`DROP TABLE IF EXISTS "conversation_memories"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "research_cache"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_pipeline_runs_step"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_pipeline_runs_conversationId"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "pipeline_runs"`);

    // Recreate the legacy checkpoint table so the previous schema is restorable.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "conversation_memories" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "conversationId" uuid NOT NULL,
        "checkpointId" varchar(255) NOT NULL,
        "graphState" jsonb NOT NULL,
        "currentNode" varchar(100) NOT NULL,
        "executedNodes" varchar[] NOT NULL DEFAULT '{}',
        "toolResults" jsonb,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "isCompleted" boolean NOT NULL DEFAULT false,
        CONSTRAINT "FK_conversation_memories_conversation"
          FOREIGN KEY ("conversationId")
          REFERENCES "conversations"("id")
          ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_conversation_memories_conversationId"
      ON "conversation_memories" ("conversationId")
    `);
  }
}
