import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Corrective migration for the production incident:
 * `column McpServer.longDescription does not exist`.
 *
 * ROOT CAUSE
 * ----------
 * 1733500000000-CreateMcpServersTable created `mcp_servers` with unquoted
 * snake_case column names (`long_description`, `author_id`, `repository_url`,
 * `gist_url`, `download_url`, `env_vars`, `download_count`, `view_count`,
 * `rating_count`, `source_conversation_id`, `created_at`, `updated_at`,
 * `published_at`), but `McpServer` (src/database/entities/mcp-server.entity.ts)
 * declares those properties with NO `@Column({ name: ... })` override, so
 * TypeORM's default naming strategy expects the literal camelCase property
 * name as the column name (`longDescription`, `authorId`, etc). Every other
 * table's migration either used quoted camelCase identifiers throughout
 * (conversations, deployments, users, usage_records, subscriptions,
 * pipeline_runs, api_keys) or the entity carries explicit snake_case `name:`
 * overrides that match (hosted_servers) - `mcp_servers` is the one place
 * where neither happened, so `mcp_servers` is the only table with this class
 * of drift. This was true from the single commit that introduced the table
 * (4bceb2e) - it was never a later edit - dev only ever masked it because
 * dev boots with `synchronize: true`, which silently creates the camelCase
 * columns TypeORM actually expects; production runs migrations only, and hit
 * the missing column at query time.
 *
 * DISCOVERY METHOD
 * -----------------
 * Full migration chain replayed on a scratch Postgres (pgvector/pgvector:pg17,
 * matching the k8s initContainer's requirement for the vector extension used
 * by the now-dropped `research_cache` migration), then
 * `typeorm migration:generate` was run against it to diff the resulting
 * schema against the current entities. That is the authoritative source for
 * every statement below - nothing here is guesswork. A handful of
 * entity-level fixes (see git diff on the *.entity.ts files in this same
 * change) were made first to eliminate diff noise that wasn't real drift
 * (FK constraint names, unnamed @Index() hash names, DB-only indexes with no
 * TypeORM representation) before generating the final, minimal diff that
 * this migration encodes.
 *
 * WHAT THIS MIGRATION DOES (and why each category was decided the way it was)
 * -----------------------------------------------------------------------
 * 1. RENAMES (not drop+add) the 13 mis-cased mcp_servers columns to their
 *    camelCase entity names. A naive `migration:generate` emits
 *    DROP COLUMN + ADD COLUMN for these, which would silently discard any
 *    data already written to them in production - renaming preserves it.
 *    Guarded so it's a no-op on a DB where the columns are already camelCase
 *    (e.g. a dev DB built via `synchronize: true`).
 * 2. RENAMES 7 mcp_servers indexes from the unquoted-lowercase names Postgres
 *    folded them to (`idx_mcp_servers_name`, ...) to the exact quoted names
 *    the entities' @Index() decorators declare (`IDX_mcp_servers_name`, ...).
 *    Same index, same columns - purely a name reconciliation so
 *    `migration:generate` stops proposing to drop+recreate them.
 * 3. DROPS 4 CHECK constraints (mcp_servers: visibility/language/status;
 *    hosted_servers: status) that were added directly in raw SQL migrations
 *    but have no TypeORM representation anywhere in this schema - no other
 *    enum-like column here is DB-CHECK-enforced (deployments.status,
 *    deployments.deploymentType, api_keys, etc. all rely on the TypeScript
 *    union type only). This is a deliberate, non-destructive choice for
 *    consistency: dropping a CHECK never discards data (existing rows already
 *    satisfy it), it only removes redundant DB-level enforcement that was
 *    inconsistently applied to just these two tables.
 * 4. ADDS the 6 genuinely-missing `deployments` validation columns
 *    (validationStatus, validatedAt, toolsPassedCount, toolsTestedCount,
 *    validationResults, workflowRunId) that the Deployment entity has always
 *    declared but no migration ever created.
 * 5. Backfills-then-tightens NOT NULL on columns where the entity has no
 *    `nullable: true` but the raw-SQL migration creating them only set a
 *    DEFAULT (not NOT NULL): users, usage_records, subscriptions, mcp_servers,
 *    hosted_servers. Every affected column has had a DEFAULT since the
 *    migration that created it, so a backfill UPDATE is defensive rather than
 *    expected to touch any rows; it runs before the constraint anyway in case
 *    a row was ever inserted bypassing the app defaults.
 * 6. Re-asserts `hosted_servers.last_status_change`'s default as `NOW()` -
 *    cosmetic (Postgres already normalizes `NOW()`/`now()` to the same stored
 *    form) but harmless and cheap to include for exact convergence.
 *
 * All statements are written to be safe to run twice and safe to run against
 * a DB that was built by `synchronize: true` from the entities directly
 * (some columns/renames/constraints already in their target state) - see the
 * guards on every rename and the IF [NOT] EXISTS / idempotent nature of the
 * rest.
 */
export class FixMcpServersSchemaDrift1753900010000 implements MigrationInterface {
  name = 'FixMcpServersSchemaDrift1753900010000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- 1. Rename mis-cased mcp_servers columns (data-preserving) ---------
    const columnRenames: Array<[string, string]> = [
      ['long_description', 'longDescription'],
      ['author_id', 'authorId'],
      ['repository_url', 'repositoryUrl'],
      ['gist_url', 'gistUrl'],
      ['download_url', 'downloadUrl'],
      ['env_vars', 'envVars'],
      ['download_count', 'downloadCount'],
      ['view_count', 'viewCount'],
      ['rating_count', 'ratingCount'],
      ['source_conversation_id', 'sourceConversationId'],
      ['created_at', 'createdAt'],
      ['updated_at', 'updatedAt'],
      ['published_at', 'publishedAt'],
    ];
    for (const [oldName, newName] of columnRenames) {
      await queryRunner.query(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'mcp_servers' AND column_name = '${oldName}'
          ) AND NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'mcp_servers' AND column_name = '${newName}'
          ) THEN
            ALTER TABLE "mcp_servers" RENAME COLUMN "${oldName}" TO "${newName}";
          END IF;
        END $$;
      `);
    }

    // --- 2. Rename mcp_servers indexes to match entity @Index() names ------
    const indexRenames: Array<[string, string]> = [
      ['idx_mcp_servers_name', 'IDX_mcp_servers_name'],
      ['idx_mcp_servers_slug', 'IDX_mcp_servers_slug'],
      ['idx_mcp_servers_category', 'IDX_mcp_servers_category'],
      ['idx_mcp_servers_visibility', 'IDX_mcp_servers_visibility'],
      ['idx_mcp_servers_status', 'IDX_mcp_servers_status'],
      ['idx_mcp_servers_author_id', 'IDX_mcp_servers_authorId'],
      ['idx_mcp_servers_featured', 'IDX_mcp_servers_featured'],
    ];
    for (const [oldName, newName] of indexRenames) {
      await queryRunner.query(`
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_class WHERE relname = '${oldName}')
             AND NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = '${newName}') THEN
            ALTER INDEX "${oldName}" RENAME TO "${newName}";
          END IF;
        END $$;
      `);
    }

    // --- 3. Drop CHECK constraints with no TypeORM representation ----------
    await queryRunner.query(
      `ALTER TABLE "mcp_servers" DROP CONSTRAINT IF EXISTS "mcp_servers_visibility_check"`,
    );
    await queryRunner.query(
      `ALTER TABLE "mcp_servers" DROP CONSTRAINT IF EXISTS "mcp_servers_language_check"`,
    );
    await queryRunner.query(
      `ALTER TABLE "mcp_servers" DROP CONSTRAINT IF EXISTS "mcp_servers_status_check"`,
    );
    await queryRunner.query(
      `ALTER TABLE "hosted_servers" DROP CONSTRAINT IF EXISTS "hosted_servers_status_check"`,
    );

    // --- 4. Add genuinely-missing deployments validation columns -----------
    await queryRunner.query(`
      ALTER TABLE "deployments"
        ADD COLUMN IF NOT EXISTS "validationStatus" character varying(20) NOT NULL DEFAULT 'pending',
        ADD COLUMN IF NOT EXISTS "validatedAt" TIMESTAMP,
        ADD COLUMN IF NOT EXISTS "toolsPassedCount" integer,
        ADD COLUMN IF NOT EXISTS "toolsTestedCount" integer,
        ADD COLUMN IF NOT EXISTS "validationResults" jsonb,
        ADD COLUMN IF NOT EXISTS "workflowRunId" character varying
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'deployments' AND column_name = 'validationStatus'
        ) AND NOT EXISTS (
          SELECT 1 FROM pg_class WHERE relname = 'IDX_deployments_validationStatus'
        ) THEN
          CREATE INDEX "IDX_deployments_validationStatus" ON "deployments" ("validationStatus");
        END IF;
      END $$;
    `);

    // --- 5. Backfill + tighten NOT NULL where entity has no nullable:true --
    const notNullColumns: Array<{ table: string; column: string; backfill: string }> = [
      { table: 'users', column: 'isActive', backfill: 'true' },
      { table: 'users', column: 'isEmailVerified', backfill: 'false' },
      { table: 'users', column: 'tier', backfill: "'free'" },
      { table: 'users', column: 'createdAt', backfill: 'now()' },
      { table: 'users', column: 'updatedAt', backfill: 'now()' },
      { table: 'usage_records', column: 'serversDeployedThisMonth', backfill: '0' },
      { table: 'usage_records', column: 'monthlyLimit', backfill: '5' },
      { table: 'usage_records', column: 'createdAt', backfill: 'now()' },
      { table: 'usage_records', column: 'updatedAt', backfill: 'now()' },
      { table: 'subscriptions', column: 'tier', backfill: "'free'" },
      { table: 'subscriptions', column: 'status', backfill: "'active'" },
      { table: 'subscriptions', column: 'cancelAtPeriodEnd', backfill: 'false' },
      { table: 'subscriptions', column: 'createdAt', backfill: 'now()' },
      { table: 'subscriptions', column: 'updatedAt', backfill: 'now()' },
      { table: 'mcp_servers', column: 'visibility', backfill: "'public'" },
      { table: 'mcp_servers', column: 'language', backfill: "'typescript'" },
      { table: 'mcp_servers', column: 'rating', backfill: '0' },
      { table: 'mcp_servers', column: 'status', backfill: "'pending'" },
      { table: 'mcp_servers', column: 'featured', backfill: 'false' },
      // These 5 are the renamed mcp_servers columns (see column renames
      // above) - the original migration gave them a DEFAULT but never
      // NOT NULL, and since a rename preserves the existing column
      // definition verbatim, that has to be tightened here too.
      { table: 'mcp_servers', column: 'downloadCount', backfill: '0' },
      { table: 'mcp_servers', column: 'viewCount', backfill: '0' },
      { table: 'mcp_servers', column: 'ratingCount', backfill: '0' },
      { table: 'mcp_servers', column: 'createdAt', backfill: 'now()' },
      { table: 'mcp_servers', column: 'updatedAt', backfill: 'now()' },
      { table: 'hosted_servers', column: 'image_tag', backfill: "'latest'" },
      { table: 'hosted_servers', column: 'k8s_namespace', backfill: "'mcp-servers'" },
      { table: 'hosted_servers', column: 'status', backfill: "'pending'" },
      { table: 'hosted_servers', column: 'last_status_change', backfill: 'now()' },
      { table: 'hosted_servers', column: 'request_count', backfill: '0' },
      { table: 'hosted_servers', column: 'created_at', backfill: 'now()' },
      { table: 'hosted_servers', column: 'updated_at', backfill: 'now()' },
    ];
    for (const { table, column, backfill } of notNullColumns) {
      await queryRunner.query(
        `UPDATE "${table}" SET "${column}" = ${backfill} WHERE "${column}" IS NULL`,
      );
      await queryRunner.query(`ALTER TABLE "${table}" ALTER COLUMN "${column}" SET NOT NULL`);
    }

    // --- 6. Cosmetic default re-assertion (harmless, safe to repeat) -------
    await queryRunner.query(
      `ALTER TABLE "hosted_servers" ALTER COLUMN "last_status_change" SET DEFAULT NOW()`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Best-effort reversal. Re-adding the CHECK constraints and re-widening
    // NOT NULL back to nullable is included for completeness; the column and
    // index renames are reversed with the same existence guards as up().

    await queryRunner.query(
      `ALTER TABLE "hosted_servers" ALTER COLUMN "last_status_change" SET DEFAULT now()`,
    );

    const notNullColumnsDown: Array<{ table: string; column: string }> = [
      { table: 'users', column: 'isActive' },
      { table: 'users', column: 'isEmailVerified' },
      { table: 'users', column: 'tier' },
      { table: 'users', column: 'createdAt' },
      { table: 'users', column: 'updatedAt' },
      { table: 'usage_records', column: 'serversDeployedThisMonth' },
      { table: 'usage_records', column: 'monthlyLimit' },
      { table: 'usage_records', column: 'createdAt' },
      { table: 'usage_records', column: 'updatedAt' },
      { table: 'subscriptions', column: 'tier' },
      { table: 'subscriptions', column: 'status' },
      { table: 'subscriptions', column: 'cancelAtPeriodEnd' },
      { table: 'subscriptions', column: 'createdAt' },
      { table: 'subscriptions', column: 'updatedAt' },
      { table: 'mcp_servers', column: 'visibility' },
      { table: 'mcp_servers', column: 'language' },
      { table: 'mcp_servers', column: 'rating' },
      { table: 'mcp_servers', column: 'status' },
      { table: 'mcp_servers', column: 'featured' },
      { table: 'mcp_servers', column: 'downloadCount' },
      { table: 'mcp_servers', column: 'viewCount' },
      { table: 'mcp_servers', column: 'ratingCount' },
      { table: 'mcp_servers', column: 'createdAt' },
      { table: 'mcp_servers', column: 'updatedAt' },
      { table: 'hosted_servers', column: 'image_tag' },
      { table: 'hosted_servers', column: 'k8s_namespace' },
      { table: 'hosted_servers', column: 'status' },
      { table: 'hosted_servers', column: 'last_status_change' },
      { table: 'hosted_servers', column: 'request_count' },
      { table: 'hosted_servers', column: 'created_at' },
      { table: 'hosted_servers', column: 'updated_at' },
    ];
    for (const { table, column } of notNullColumnsDown) {
      await queryRunner.query(`ALTER TABLE "${table}" ALTER COLUMN "${column}" DROP NOT NULL`);
    }

    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_deployments_validationStatus"`);
    await queryRunner.query(`
      ALTER TABLE "deployments"
        DROP COLUMN IF EXISTS "workflowRunId",
        DROP COLUMN IF EXISTS "validationResults",
        DROP COLUMN IF EXISTS "toolsTestedCount",
        DROP COLUMN IF EXISTS "toolsPassedCount",
        DROP COLUMN IF EXISTS "validatedAt",
        DROP COLUMN IF EXISTS "validationStatus"
    `);

    await queryRunner.query(`
      ALTER TABLE "hosted_servers" ADD CONSTRAINT "hosted_servers_status_check"
        CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'building'::character varying, 'pushing'::character varying, 'deploying'::character varying, 'running'::character varying, 'stopped'::character varying, 'failed'::character varying, 'deleted'::character varying])::text[])))
    `);
    await queryRunner.query(`
      ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_status_check"
        CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'approved'::character varying, 'rejected'::character varying, 'archived'::character varying])::text[])))
    `);
    await queryRunner.query(`
      ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_language_check"
        CHECK (((language)::text = ANY ((ARRAY['typescript'::character varying, 'python'::character varying, 'javascript'::character varying])::text[])))
    `);
    await queryRunner.query(`
      ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_visibility_check"
        CHECK (((visibility)::text = ANY ((ARRAY['public'::character varying, 'private'::character varying, 'unlisted'::character varying])::text[])))
    `);

    const indexRenamesDown: Array<[string, string]> = [
      ['IDX_mcp_servers_name', 'idx_mcp_servers_name'],
      ['IDX_mcp_servers_slug', 'idx_mcp_servers_slug'],
      ['IDX_mcp_servers_category', 'idx_mcp_servers_category'],
      ['IDX_mcp_servers_visibility', 'idx_mcp_servers_visibility'],
      ['IDX_mcp_servers_status', 'idx_mcp_servers_status'],
      ['IDX_mcp_servers_authorId', 'idx_mcp_servers_author_id'],
      ['IDX_mcp_servers_featured', 'idx_mcp_servers_featured'],
    ];
    for (const [oldName, newName] of indexRenamesDown) {
      await queryRunner.query(`
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_class WHERE relname = '${oldName}')
             AND NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = '${newName}') THEN
            ALTER INDEX "${oldName}" RENAME TO "${newName}";
          END IF;
        END $$;
      `);
    }

    const columnRenamesDown: Array<[string, string]> = [
      ['longDescription', 'long_description'],
      ['authorId', 'author_id'],
      ['repositoryUrl', 'repository_url'],
      ['gistUrl', 'gist_url'],
      ['downloadUrl', 'download_url'],
      ['envVars', 'env_vars'],
      ['downloadCount', 'download_count'],
      ['viewCount', 'view_count'],
      ['ratingCount', 'rating_count'],
      ['sourceConversationId', 'source_conversation_id'],
      ['createdAt', 'created_at'],
      ['updatedAt', 'updated_at'],
      ['publishedAt', 'published_at'],
    ];
    for (const [oldName, newName] of columnRenamesDown) {
      await queryRunner.query(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'mcp_servers' AND column_name = '${oldName}'
          ) AND NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'mcp_servers' AND column_name = '${newName}'
          ) THEN
            ALTER TABLE "mcp_servers" RENAME COLUMN "${oldName}" TO "${newName}";
          END IF;
        END $$;
      `);
    }
  }
}
