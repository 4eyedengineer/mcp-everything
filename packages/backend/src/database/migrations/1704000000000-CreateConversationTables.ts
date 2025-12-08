import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateConversationTables1704000000000 implements MigrationInterface {
  name = 'CreateConversationTables1704000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Enable UUID extension - required for uuid_generate_v4()
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    await queryRunner.query(`
      CREATE TABLE "conversations" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "sessionId" varchar(255) NOT NULL,
        "messages" jsonb NOT NULL,
        "state" jsonb,
        "currentStage" varchar(100),
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        "isActive" boolean NOT NULL DEFAULT true
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_conversations_sessionId" ON "conversations" ("sessionId")
    `);

    await queryRunner.query(`
      CREATE TABLE "conversation_memories" (
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
      CREATE INDEX "IDX_conversation_memories_conversationId"
      ON "conversation_memories" ("conversationId")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_conversation_memories_checkpointId"
      ON "conversation_memories" ("conversationId", "checkpointId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_conversation_memories_checkpointId"`);
    await queryRunner.query(`DROP INDEX "IDX_conversation_memories_conversationId"`);
    await queryRunner.query(`DROP TABLE "conversation_memories"`);
    await queryRunner.query(`DROP INDEX "IDX_conversations_sessionId"`);
    await queryRunner.query(`DROP TABLE "conversations"`);
  }
}
