import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Give `hosted_servers` its own copy of the generated server's source path.
 *
 * The bug this fixes: `localPath` - the only pointer to the generated source
 * a hosted server was built from - lived exclusively on `deployments`, and
 * `deployments.conversationId` is `ON DELETE CASCADE`. `hosted_servers`
 * .conversation_id is only `ON DELETE SET NULL`. So deleting a chat destroyed
 * the source pointer while leaving the hosted server row (and its actual
 * running container) alive and unrebuildable - `HostingService.startServer`
 * even has a guard for the resulting state but had no way to recover from it.
 *
 * A row that outlives its parent must not depend on the parent for anything
 * it needs to function, so the value is copied here rather than joined.
 */
export class AddHostedServerSelfSufficiency1754100000000 implements MigrationInterface {
  name = 'AddHostedServerSelfSufficiency1754100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE hosted_servers ADD COLUMN IF NOT EXISTS local_path TEXT
    `);

    // Backfill from the deployment each hosted server was created from.
    // DISTINCT ON + ORDER BY "createdAt" DESC mirrors exactly how
    // HostingService.deployToCloud picks the deployment for a conversation
    // (`order: { createdAt: 'DESC' }`), so the backfilled path is the one the
    // server was actually built from.
    await queryRunner.query(`
      UPDATE hosted_servers hs
      SET local_path = d."localPath"
      FROM (
        SELECT DISTINCT ON ("conversationId") "conversationId", "localPath"
        FROM deployments
        WHERE "localPath" IS NOT NULL
        ORDER BY "conversationId", "createdAt" DESC
      ) d
      WHERE hs.conversation_id = d."conversationId"
        AND hs.local_path IS NULL
    `);

    // HOSTING_MODE=docker-run servers already stashed the path in their
    // `config` jsonb; use it wherever the deployments join found nothing
    // (e.g. the conversation was already deleted).
    await queryRunner.query(`
      UPDATE hosted_servers
      SET local_path = config->>'localPath'
      WHERE local_path IS NULL
        AND config IS NOT NULL
        AND config->>'localPath' IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE hosted_servers DROP COLUMN IF EXISTS local_path`);
  }
}
