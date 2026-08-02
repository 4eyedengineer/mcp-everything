import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { HostedServerApiKey } from '../database/entities/hosted-server-api-key.entity';
import { HostedServer } from '../database/entities/hosted-server.entity';

/** Metadata safe to hand back to a client. Never contains secret material. */
export interface HostedServerApiKeySummary {
  id: string;
  label: string;
  keyPrefix: string;
  lastFour: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  /** Derived: not revoked and not past its expiry. */
  active: boolean;
}

export interface CreatedHostedServerApiKey {
  key: HostedServerApiKeySummary;
  /**
   * The full plaintext key. Returned exactly once, here. Only its SHA-256
   * hash is persisted, so this value is unrecoverable afterwards.
   */
  plaintextKey: string;
}

export interface CreateHostedServerApiKeyOptions {
  label: string;
  /** Optional lifetime in days. Omit for a key that never expires. */
  expiresInDays?: number;
}

/**
 * Issues, lists, revokes and verifies per-hosted-server API key credentials.
 *
 * ---------------------------------------------------------------------------
 * SCOPE / HONESTY NOTE - READ BEFORE ASSUMING THIS SECURES ANYTHING
 * ---------------------------------------------------------------------------
 * Nothing in this repository calls `verifyKey()` on a request path. Hosted MCP
 * servers are still reachable at their `endpointUrl` with NO authentication;
 * the only thing protecting them is that the URL contains an unguessable id.
 *
 * The intended enforcement point is a backend gateway that proxies traffic to
 * hosted pods and rejects requests without a valid key. That gateway does not
 * exist yet. Until it does, creating a key here provisions a credential and
 * changes nothing about who can reach a hosted server.
 * ---------------------------------------------------------------------------
 */
@Injectable()
export class HostedServerApiKeyService {
  private readonly logger = new Logger(HostedServerApiKeyService.name);

  /**
   * Prefix on every issued key: `mcps_` = MCP *server* key.
   *
   * Deliberately distinct from `ApiKeyService.KEY_PREFIX` (`mcpe_`, the
   * user-level platform key) so the two credential kinds cannot be mistaken
   * for one another in a log line, a support ticket, or JwtAuthGuard's
   * `mcpe_`-prefixed API-key branch.
   */
  static readonly KEY_PREFIX = 'mcps_';

  /** Bytes of randomness per key. 32 bytes = 256 bits of entropy. */
  static readonly KEY_RANDOM_BYTES = 32;

  /** Chars of the random portion retained in the non-secret display prefix. */
  static readonly DISPLAY_PREFIX_RANDOM_CHARS = 6;

  /**
   * Max simultaneously-active keys per server. Two is enough to rotate; five
   * leaves room for per-consumer keys without turning the verify path into an
   * unbounded scan.
   */
  static readonly MAX_ACTIVE_KEYS_PER_SERVER = 5;

  constructor(
    @InjectRepository(HostedServerApiKey)
    private readonly apiKeyRepository: Repository<HostedServerApiKey>,
    @InjectRepository(HostedServer)
    private readonly hostedServerRepository: Repository<HostedServer>,
  ) {}

  /**
   * Create a key for a server the user owns.
   *
   * The plaintext key exists only in the returned value - it is never stored,
   * never logged, and cannot be retrieved again.
   */
  async createKey(
    serverId: string,
    userId: string,
    options: CreateHostedServerApiKeyOptions,
  ): Promise<CreatedHostedServerApiKey> {
    const server = await this.getOwnedServerOrFail(serverId, userId);

    const label = (options.label ?? '').trim();
    if (!label) {
      throw new BadRequestException('A label is required for an API key');
    }

    const activeCount = await this.countActiveKeys(server.id);
    if (activeCount >= HostedServerApiKeyService.MAX_ACTIVE_KEYS_PER_SERVER) {
      throw new BadRequestException(
        `Server ${serverId} already has ${activeCount} active API keys ` +
          `(maximum ${HostedServerApiKeyService.MAX_ACTIVE_KEYS_PER_SERVER}). ` +
          'Revoke an existing key before creating another.',
      );
    }

    let expiresAt: Date | null = null;
    if (options.expiresInDays !== undefined && options.expiresInDays !== null) {
      if (!Number.isFinite(options.expiresInDays) || options.expiresInDays <= 0) {
        throw new BadRequestException('expiresInDays must be a positive number');
      }
      expiresAt = new Date(Date.now() + options.expiresInDays * 24 * 60 * 60 * 1000);
    }

    const plaintextKey = this.generateRawKey();

    const entity = this.apiKeyRepository.create({
      hostedServerId: server.id,
      keyHash: this.hashKey(plaintextKey),
      keyPrefix: this.derivePrefix(plaintextKey),
      lastFour: plaintextKey.slice(-4),
      label,
      createdByUserId: userId,
      expiresAt,
      revokedAt: null,
      lastUsedAt: null,
    });

    const saved = await this.apiKeyRepository.save(entity);

    // Logs the non-secret prefix only - never the key.
    this.logger.log(
      `Issued API key ${saved.id} (${saved.keyPrefix}...) for hosted server ${serverId}`,
    );

    return { key: this.toSummary(saved), plaintextKey };
  }

  /**
   * List key metadata (active and revoked) for a server the user owns.
   * The plaintext key does not exist in the database, so it cannot leak here.
   */
  async listKeys(serverId: string, userId: string): Promise<HostedServerApiKeySummary[]> {
    const server = await this.getOwnedServerOrFail(serverId, userId);

    const keys = await this.apiKeyRepository.find({
      where: { hostedServerId: server.id },
      order: { createdAt: 'DESC' },
    });

    return keys.map((key) => this.toSummary(key));
  }

  /**
   * Revoke a key on a server the user owns. Idempotent: revoking an
   * already-revoked key leaves the original `revokedAt` untouched.
   */
  async revokeKey(
    serverId: string,
    keyId: string,
    userId: string,
  ): Promise<HostedServerApiKeySummary> {
    const server = await this.getOwnedServerOrFail(serverId, userId);

    const key = await this.apiKeyRepository.findOne({
      where: { id: keyId, hostedServerId: server.id },
    });

    if (!key) {
      // Do not distinguish "no such key" from "key of another server".
      throw new NotFoundException(`API key not found for server ${serverId}`);
    }

    if (key.revokedAt) {
      return this.toSummary(key);
    }

    key.revokedAt = new Date();
    const saved = await this.apiKeyRepository.save(key);

    this.logger.log(`Revoked API key ${keyId} for hosted server ${serverId}`);
    return this.toSummary(saved);
  }

  /**
   * Verify a presented key against the active keys of one hosted server.
   *
   * Returns the matching row, or null when the key is unknown, revoked,
   * expired, or belongs to a different server.
   *
   * !! THIS METHOD HAS NO CALLER YET !!
   * It is the verification primitive a future hosted-MCP gateway would call.
   * No request path in this repository invokes it, so hosted servers currently
   * accept traffic without presenting any credential at all. The existence of
   * this method is NOT evidence that hosted servers are authenticated.
   */
  async verifyKey(
    serverId: string,
    presentedKey: string,
  ): Promise<HostedServerApiKey | null> {
    if (!presentedKey) {
      return null;
    }

    const server = await this.hostedServerRepository.findOne({
      where: { serverId },
      select: ['id', 'status'],
    });
    // A deleted server's credentials are dead with it, even though the rows
    // survive the soft delete.
    if (!server || server.status === 'deleted') {
      return null;
    }

    const candidates = await this.apiKeyRepository.find({
      where: { hostedServerId: server.id, revokedAt: IsNull() },
    });

    const presentedDigest = Buffer.from(this.hashKey(presentedKey), 'hex');
    const now = new Date();

    let match: HostedServerApiKey | null = null;

    for (const candidate of candidates) {
      // Timing-safe digest comparison. A plain `===` on the hex strings would
      // short-circuit at the first differing character, leaking how much of a
      // guessed key was correct.
      const storedDigest = Buffer.from(candidate.keyHash ?? '', 'hex');
      if (storedDigest.length !== presentedDigest.length) {
        continue;
      }

      const digestsEqual = timingSafeEqual(storedDigest, presentedDigest);

      // No early `break`: the loop does the same work regardless of which
      // candidate matched.
      if (digestsEqual && !this.isExpired(candidate, now)) {
        match = candidate;
      }
    }

    if (!match) {
      return null;
    }

    try {
      await this.apiKeyRepository.update({ id: match.id }, { lastUsedAt: now });
      match.lastUsedAt = now;
    } catch (error) {
      // A bookkeeping failure must never deny an otherwise-valid key.
      this.logger.warn(`Failed to update lastUsedAt for hosted server API key ${match.id}: ${error}`);
    }

    return match;
  }

  /** Number of keys that would currently verify: not revoked, not expired. */
  async countActiveKeys(hostedServerId: string): Promise<number> {
    const keys = await this.apiKeyRepository.find({
      where: { hostedServerId, revokedAt: IsNull() },
    });
    const now = new Date();
    return keys.filter((key) => !this.isExpired(key, now)).length;
  }

  // --- Helpers ---

  /**
   * `mcps_` + 32 random bytes base64url-encoded (43 chars, 256 bits).
   * base64url keeps the key copy-pasteable and safe in an HTTP header.
   */
  private generateRawKey(): string {
    return `${HostedServerApiKeyService.KEY_PREFIX}${randomBytes(
      HostedServerApiKeyService.KEY_RANDOM_BYTES,
    ).toString('base64url')}`;
  }

  /**
   * SHA-256 hex. Not bcrypt/argon2, deliberately: the input is a 256-bit
   * random token rather than a user-chosen password, so a slow KDF buys no
   * additional resistance to guessing while adding latency to what is meant to
   * be a per-request verification path. Matches ApiKeyService and the
   * password-reset token hashing in AuthService.
   */
  private hashKey(rawKey: string): string {
    return createHash('sha256').update(rawKey).digest('hex');
  }

  /** `mcps_` + the first few chars of the random portion, for display only. */
  private derivePrefix(rawKey: string): string {
    return rawKey.slice(
      0,
      HostedServerApiKeyService.KEY_PREFIX.length +
        HostedServerApiKeyService.DISPLAY_PREFIX_RANDOM_CHARS,
    );
  }

  private isExpired(key: HostedServerApiKey, now: Date): boolean {
    return key.expiresAt ? key.expiresAt.getTime() <= now.getTime() : false;
  }

  private toSummary(key: HostedServerApiKey): HostedServerApiKeySummary {
    return {
      id: key.id,
      label: key.label,
      keyPrefix: key.keyPrefix,
      lastFour: key.lastFour,
      createdAt: key.createdAt,
      lastUsedAt: key.lastUsedAt ?? null,
      expiresAt: key.expiresAt ?? null,
      revokedAt: key.revokedAt ?? null,
      active: !key.revokedAt && !this.isExpired(key, new Date()),
    };
  }

  /**
   * Resolve a hosted server by its URL-safe id and assert the caller owns it.
   *
   * Mirrors HostingService.getServerByIdOrFail: a server that exists but
   * belongs to someone else is reported as not found, so key management cannot
   * be used to probe for other users' server ids. Legacy rows with a null
   * `user_id` have no owner and are therefore manageable by nobody.
   */
  private async getOwnedServerOrFail(serverId: string, userId: string): Promise<HostedServer> {
    if (!userId) {
      throw new ForbiddenException('Authentication is required to manage API keys');
    }

    const server = await this.hostedServerRepository.findOne({
      where: { serverId, userId },
    });

    if (!server) {
      throw new NotFoundException(`Server not found: ${serverId}`);
    }

    return server;
  }
}
