import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-server source-fetch tokens.
 *
 * A hosted MCP server's pod authenticates with one of these to pull its own
 * generated source from `GET /api/hosting/servers/:serverId/source`. The source
 * itself already lives durably in `conversations.state.generatedCode`; this
 * table only governs who may read it.
 *
 * Separate from `hosted_server_api_keys` on purpose - those are held by the
 * server's consumers and grant tool access; these are held by the server's own
 * pod and grant read access to the owner's source. See
 * HostedServerSourceToken for the full rationale.
 *
 * Only the SHA-256 hash is stored. `expires_at` is NOT NULL: unlike a key a
 * human mints and can see in a list, nobody will ever review this one.
 */
export class CreateHostedServerSourceTokensTable1754500000000 implements MigrationInterface {
  name = 'CreateHostedServerSourceTokensTable1754500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS hosted_server_source_tokens (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        hosted_server_id UUID NOT NULL
          REFERENCES hosted_servers(id) ON DELETE CASCADE,

        -- Secret material: hash only, never the plaintext
        token_hash CHAR(64) NOT NULL,

        -- Non-secret display material, for logs and support
        token_prefix VARCHAR(32) NOT NULL,

        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMP NOT NULL,
        revoked_at TIMESTAMP,
        last_used_at TIMESTAMP,
        use_count INTEGER NOT NULL DEFAULT 0
      );
    `);

    // A given secret may only ever exist once, across all servers.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_hosted_server_source_tokens_token_hash
        ON hosted_server_source_tokens(token_hash);
    `);

    // Verification and revoke-all both start from the owning server.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_hosted_server_source_tokens_hosted_server_id
        ON hosted_server_source_tokens(hosted_server_id);
    `);

    // Partial index for the hot path: the (normally single) live token of one
    // server. Mirrors idx_hosted_server_api_keys_active.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_hosted_server_source_tokens_active
        ON hosted_server_source_tokens(hosted_server_id)
        WHERE revoked_at IS NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS hosted_server_source_tokens;`);
  }
}
