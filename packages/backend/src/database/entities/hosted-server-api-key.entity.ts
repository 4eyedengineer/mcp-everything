import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { HostedServer } from './hosted-server.entity';

/**
 * An API key credential belonging to a single hosted MCP server.
 *
 * This is a CHILD table rather than a column on `hosted_servers` on purpose:
 * rotating a key requires the old and the new key to be valid at the same time
 * for a cutover window, which a single column cannot express.
 *
 * IMPORTANT / SCOPE: at the time this table was added there is no request path
 * that verifies these keys. Hosted MCP servers are reachable at their endpoint
 * URL with NO authentication; the de facto protection is that the URL contains
 * an unguessable id. These rows are credential *infrastructure* (issue, store,
 * revoke, verify) for a future gateway. Issuing a key does not currently
 * protect anything. See HostedServerApiKeyService.verifyKey().
 *
 * Only the SHA-256 hash of the key is stored. The plaintext is returned exactly
 * once, at creation time, and is not recoverable afterwards.
 *
 * Has a `ManyToOne` relation back to `HostedServer` purely so the FK
 * constraint name (`hosted_server_api_keys_hosted_server_id_fkey`, set by
 * 1754300000000-CreateHostedServerApiKeysTable.ts) and `ON DELETE CASCADE`
 * are declared to TypeORM and `migration:generate` does not propose dropping
 * and recreating it under a hashed name. The plain `hostedServerId` column
 * below remains the normal way to read/write the id; the relation is not
 * eagerly loaded anywhere.
 */
@Entity('hosted_server_api_keys')
@Index('idx_hosted_server_api_keys_active', ['hostedServerId'], {
  where: 'revoked_at IS NULL',
})
export class HostedServerApiKey {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** FK to hosted_servers.id (the UUID primary key, not the URL-safe serverId). */
  @Index('idx_hosted_server_api_keys_hosted_server_id')
  @Column({ name: 'hosted_server_id', type: 'uuid' })
  hostedServerId: string;

  @ManyToOne(() => HostedServer, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'hosted_server_id',
    foreignKeyConstraintName: 'hosted_server_api_keys_hosted_server_id_fkey',
  })
  hostedServer: HostedServer;

  /**
   * Lowercase hex SHA-256 of the full plaintext key.
   *
   * SHA-256 (not bcrypt/argon2) is deliberate: these are 256-bit
   * cryptographically-random tokens, not user-chosen passwords. A slow KDF only
   * buys value when the input is guessable; brute-forcing a 256-bit random
   * token is infeasible regardless of hash speed, and a slow KDF would add
   * per-request latency on what is meant to be a hot verification path.
   * This also matches how password-reset tokens are hashed in AuthService and
   * how user-level platform keys are hashed in ApiKeyService.
   */
  @Index('idx_hosted_server_api_keys_key_hash', { unique: true })
  @Column({ name: 'key_hash', type: 'char', length: 64 })
  keyHash: string;

  /**
   * Non-secret leading portion of the key, e.g. `mcps_A1b2c3`.
   * Safe to display and to log; not enough material to reconstruct the key.
   *
   * Note the `mcps_` (MCP *server*) prefix deliberately differs from the
   * `mcpe_` prefix used by user-level platform keys (see ApiKey /
   * ApiKeyService) so the two credential kinds are never confused by a human
   * reading a log or by JwtAuthGuard's `mcpe_` API-key path.
   */
  @Column({ name: 'key_prefix', type: 'varchar', length: 32 })
  keyPrefix: string;

  /** Last 4 characters of the key, for disambiguating keys in a list UI. */
  @Column({ name: 'last_four', type: 'char', length: 4 })
  lastFour: string;

  /** User-supplied name, e.g. "ci-runner" or "laptop". */
  @Column({ type: 'varchar', length: 100 })
  label: string;

  /** User who created the key (denormalized from hosted_servers.user_id for auditing). */
  @Column({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  /**
   * Updated by verifyKey() on a successful match.
   * Stays null until something actually verifies keys.
   */
  @Column({ name: 'last_used_at', type: 'timestamp', nullable: true })
  lastUsedAt: Date | null;

  /** Null means the key never expires. */
  @Column({ name: 'expires_at', type: 'timestamp', nullable: true })
  expiresAt: Date | null;

  /** Non-null means revoked; revoked keys never verify again. */
  @Column({ name: 'revoked_at', type: 'timestamp', nullable: true })
  revokedAt: Date | null;
}
