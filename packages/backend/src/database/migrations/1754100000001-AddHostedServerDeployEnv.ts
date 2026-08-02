import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Store (encrypted) the env vars a hosted server was deployed with.
 *
 * The bug this fixes: `HostingService.startServer` restarted a docker-run
 * container with an empty env map. `LocalDockerHostingService` defaults
 * `MCP_TRANSPORT` to stdio when it is absent, and stdio publishes no port -
 * so stopping and starting an HTTP-transport server left it permanently
 * unreachable at the `http://localhost:<port>` endpoint_url its own row still
 * advertises, and silently dropped any user-supplied API keys at the same
 * time.
 *
 * Why a single encrypted TEXT column and not a jsonb map: these values are
 * exactly the secrets that the existing `env_var_names` column was
 * deliberately designed NOT to store ("Required env var names (not
 * values!)"). They are encrypted with AES-256-GCM under TOKEN_ENCRYPTION_KEY
 * via TokenEncryptionService - the same mechanism already used for users'
 * GitHub access tokens - so the ciphertext is opaque to anyone reading the
 * table, and there is nothing to index or query inside it.
 *
 * There is no backfill: the plaintext values were never persisted anywhere,
 * so for pre-existing rows they are simply gone. Those servers restart with
 * whatever non-secret transport settings HostingService can recover from
 * `config.transportEnv`, and must be redeployed to regain their secrets.
 */
export class AddHostedServerDeployEnv1754100000001 implements MigrationInterface {
  name = 'AddHostedServerDeployEnv1754100000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE hosted_servers ADD COLUMN IF NOT EXISTS deploy_env_encrypted TEXT
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE hosted_servers DROP COLUMN IF EXISTS deploy_env_encrypted
    `);
  }
}
