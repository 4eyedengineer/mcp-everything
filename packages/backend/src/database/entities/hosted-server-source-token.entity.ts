import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

/**
 * A credential that lets ONE hosted server's pod fetch ITS OWN source code
 * from `GET /api/hosting/servers/:serverId/source`, with no user session.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT A `hosted_server_api_keys` ROW
 * ---------------------------------------------------------------------------
 * The two credential kinds point in opposite directions and are held by
 * different parties:
 *
 *   hosted_server_api_keys (`mcps_`)   - held by the server's CONSUMERS. Grants
 *     the right to call the server's tools through the MCP gateway. Created by
 *     a human, listed in the UI, labelled, revoked by hand.
 *   hosted_server_source_tokens (`mcpsrc_`) - held by the server's own POD.
 *     Grants read access to the OWNER'S GENERATED SOURCE. Minted by the deploy
 *     path, never shown to a human, never listed.
 *
 * Sharing a table would mean one revoke-all, one expiry policy, and one
 * listing UI for two things where handing a consumer the source-reading
 * credential (or exposing the pod's credential in a key list) is a
 * confidentiality bug. Separate tables make that mistake unrepresentable.
 * ---------------------------------------------------------------------------
 *
 * Only the SHA-256 hash of the token is stored; the plaintext exists solely in
 * the return value of `mintToken()` and is not recoverable afterwards.
 *
 * Deliberately has no ManyToOne relation back to HostedServer - the link is the
 * plain `hosted_server_id` column plus a FK constraint in the migration, which
 * matches HostedServerApiKey.
 */
@Entity('hosted_server_source_tokens')
export class HostedServerSourceToken {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** FK to hosted_servers.id (the UUID primary key, not the URL-safe serverId). */
  @Index()
  @Column({ name: 'hosted_server_id', type: 'uuid' })
  hostedServerId: string;

  /**
   * Lowercase hex SHA-256 of the full plaintext token.
   *
   * SHA-256 rather than bcrypt/argon2, matching `HostedServerApiKey.keyHash`,
   * `ApiKeyService` and the password-reset tokens in `AuthService`: the input
   * is 256 bits of `randomBytes`, not a user-chosen password, so a slow KDF
   * adds per-request latency on a verification path without making an
   * infeasible search any more infeasible.
   */
  @Index()
  @Column({ name: 'token_hash', type: 'char', length: 64 })
  tokenHash: string;

  /**
   * Non-secret leading portion, e.g. `mcpsrc_A1b2c3`. Exists so a token can be
   * referred to in a log line or a support conversation without the token
   * itself ever being written down.
   */
  @Column({ name: 'token_prefix', type: 'varchar', length: 32 })
  tokenPrefix: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  /**
   * NOT NULL, unlike `hosted_server_api_keys.expires_at`. A never-expiring
   * credential is a defensible choice for a key a human minted and can see in
   * a list; it is not defensible for one that is minted automatically, stored
   * in a pod's environment, and that nobody will ever think to review.
   */
  @Column({ name: 'expires_at', type: 'timestamp' })
  expiresAt: Date;

  /** Non-null means revoked; a revoked token never verifies again. */
  @Column({ name: 'revoked_at', type: 'timestamp', nullable: true })
  revokedAt: Date | null;

  /**
   * Set on every successful verification.
   *
   * Worth having precisely because this token is expected to be redeemed MANY
   * times (see `HostedServerSourceTokenService` on why it is not single-use):
   * a token whose `last_used_at` keeps advancing long after its server was
   * meant to be idle is the signal that it leaked.
   */
  @Column({ name: 'last_used_at', type: 'timestamp', nullable: true })
  lastUsedAt: Date | null;

  /** Number of successful verifications. Cheap anomaly signal; see above. */
  @Column({ name: 'use_count', type: 'integer', default: 0 })
  useCount: number;
}
