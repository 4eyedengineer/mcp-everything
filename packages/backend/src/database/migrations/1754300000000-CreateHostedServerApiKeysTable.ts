import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-server API key credentials for hosted MCP servers.
 *
 * Child table (not a column on hosted_servers) because rotation requires two
 * valid keys to coexist during a cutover window.
 *
 * Only the SHA-256 hash of the key is stored; the plaintext is shown once at
 * creation. key_prefix / last_four are non-secret display material.
 *
 * NOTE: nothing verifies these keys on the request path yet — hosted servers
 * are still unauthenticated. See HostedServerApiKeyService.
 */
export class CreateHostedServerApiKeysTable1754300000000
  implements MigrationInterface
{
  name = 'CreateHostedServerApiKeysTable1754300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE hosted_server_api_keys (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        hosted_server_id UUID NOT NULL
          REFERENCES hosted_servers(id) ON DELETE CASCADE,

        -- Secret material: hash only, never the plaintext
        key_hash CHAR(64) NOT NULL,

        -- Non-secret display material
        key_prefix VARCHAR(32) NOT NULL,
        last_four CHAR(4) NOT NULL,
        label VARCHAR(100) NOT NULL,

        created_by_user_id UUID,

        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        last_used_at TIMESTAMP,
        expires_at TIMESTAMP,
        revoked_at TIMESTAMP
      );

      -- A given secret may only ever exist once, across all servers.
      CREATE UNIQUE INDEX idx_hosted_server_api_keys_key_hash
        ON hosted_server_api_keys(key_hash);

      -- Verification and listing both start from the owning server.
      CREATE INDEX idx_hosted_server_api_keys_hosted_server_id
        ON hosted_server_api_keys(hosted_server_id);

      -- Partial index for the hot path: active keys of one server.
      CREATE INDEX idx_hosted_server_api_keys_active
        ON hosted_server_api_keys(hosted_server_id)
        WHERE revoked_at IS NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS hosted_server_api_keys;`);
  }
}
