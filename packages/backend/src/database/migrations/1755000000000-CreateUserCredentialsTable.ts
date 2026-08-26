import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-user encrypted credential vault.
 *
 * Lets a user store their OWN secrets (a personal GITHUB_TOKEN, a Stripe key,
 * etc.), encrypted at rest via `TokenEncryptionService` (AES-256-GCM), so
 * they can later be injected into a hosted MCP server they own without
 * re-entering the value each time. `value_encrypted` is write-only from the
 * API's perspective: `CredentialVaultService` never returns it, only
 * metadata about the credential.
 *
 * `name` is the user-facing handle used to reference a credential from a
 * deployment, scoped unique per user (`uq_user_credentials_user_id_name`) so
 * two users - or the same user across servers - can both have a credential
 * named e.g. "GITHUB_TOKEN" without collision.
 */
export class CreateUserCredentialsTable1755000000000 implements MigrationInterface {
  name = 'CreateUserCredentialsTable1755000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS user_credentials (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL
          CONSTRAINT user_credentials_user_id_fkey REFERENCES users(id) ON DELETE CASCADE,

        name VARCHAR(100) NOT NULL,
        description VARCHAR(500),

        -- Secret material: AES-256-GCM ciphertext only, never the plaintext
        value_encrypted TEXT NOT NULL,

        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
        last_used_at TIMESTAMP
      );
    `);

    // A user may not have two credentials with the same handle.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_user_credentials_user_id_name
        ON user_credentials(user_id, name);
    `);

    // Listing and delete-ownership checks both start from the owning user.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_user_credentials_user_id
        ON user_credentials(user_id);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS user_credentials;`);
  }
}
