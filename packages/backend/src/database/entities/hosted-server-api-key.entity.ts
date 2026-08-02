import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

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
 * Deliberately has no ManyToOne relation back to HostedServer — the link is the
 * plain `hosted_server_id` column plus a FK constraint in the migration.
 */
@Entity('hosted_server_api_keys')
export class HostedServerApiKey {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** FK to hosted_servers.id (the UUID primary key, not the URL-safe serverId). */
  @Index()
  @Column({ name: 'hosted_server_id', type: 'uuid' })
  hostedServerId: string;

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
  @Index()
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
