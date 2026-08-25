import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Backfill for the "Deploy/Download actions + validation badge vanish on
 * reload" bug.
 *
 * Root cause: GenerationPipeline.persist() saved the assistant's completion
 * message to `conversations.messages` (jsonb) without the generated code, so
 * GET /conversations/:id/messages had nothing for the frontend's
 * `msg.metadata?.generatedCode` read - the generated result only ever existed
 * in the one-shot SSE `complete` event and was gone after a refresh.
 * GenerationPipeline.persist() has been fixed to write
 * `messages[i].metadata.generatedCode` (and a validation summary, when a
 * refinement iteration ran) going forward.
 *
 * This migration recovers the SAME data for conversations generated before
 * that fix. It does not invent anything: `syncGeneratedCodeToConversation`
 * has always written the finished server to `conversations.state.generatedCode`
 * (used by the deployment flow), so for any conversation where that exists we
 * copy it onto the last assistant message's `metadata.generatedCode`.
 *
 * No structured validation summary is backfilled - `state.refinementHistory`
 * (build/tool pass counts) is pipeline-run-local and was never synced to
 * `conversation.state`, so there is nothing genuine to recover for legacy
 * rows. Fabricating one from the message's free-text content was considered
 * and rejected.
 *
 * No schema change is needed: `messages` is already a jsonb column, so an
 * extra `metadata` key on individual message objects requires no DDL.
 *
 * Idempotent: skips any message that already has `metadata.generatedCode`.
 */
export class BackfillMessageGeneratedCodeMetadata1753900000000 implements MigrationInterface {
  name = 'BackfillMessageGeneratedCodeMetadata1753900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const rows: Array<{ id: string; messages: unknown; state: unknown }> = await queryRunner.query(`
      SELECT id, messages, state
      FROM conversations
      WHERE state -> 'generatedCode' IS NOT NULL
        AND jsonb_typeof(messages) = 'array'
        AND jsonb_array_length(messages) > 0
    `);

    let updated = 0;

    for (const row of rows) {
      const messages = Array.isArray(row.messages) ? (row.messages as any[]) : [];
      const state = (row.state as Record<string, any>) || {};

      // The pipeline attaches generatedCode to the LAST assistant message -
      // that is the one the corresponding persist() call wrote.
      let lastAssistantIndex = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === 'assistant') {
          lastAssistantIndex = i;
          break;
        }
      }
      if (lastAssistantIndex === -1) {
        continue;
      }

      const existing = messages[lastAssistantIndex];
      if (existing?.metadata?.generatedCode) {
        continue; // Already backfilled (or generated post-fix) - skip.
      }

      messages[lastAssistantIndex] = {
        ...existing,
        metadata: {
          ...(existing?.metadata || {}),
          generatedCode: state.generatedCode,
        },
      };

      await queryRunner.query(`UPDATE conversations SET messages = $1::jsonb WHERE id = $2`, [
        JSON.stringify(messages),
        row.id,
      ]);
      updated++;
    }

    if (updated > 0) {
      console.log(
        `[BackfillMessageGeneratedCodeMetadata] backfilled generatedCode metadata onto ${updated} conversation(s).`,
      );
    }
  }

  public async down(): Promise<void> {
    // Intentionally a no-op. This migration only recovers data that was
    // already durably stored elsewhere on the same row
    // (`state.generatedCode`) into `messages[i].metadata.generatedCode` - it
    // never deletes or moves data, so there is nothing destructive to revert.
    // Reverting would require re-stripping `metadata.generatedCode` from
    // every message we touched, which is unnecessary: leaving it in place is
    // harmless and matches what the (fixed) application code writes anyway.
  }
}
