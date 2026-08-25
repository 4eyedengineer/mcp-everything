import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import { randomBytes, createHash } from 'node:crypto';
import { ApiKey } from '../database/entities/api-key.entity';

export interface CreatedApiKey {
  id: string;
  name: string;
  /** The full plaintext key. Only ever returned once, at creation time. */
  key: string;
  keyPrefix: string;
  createdAt: Date;
}

export interface ApiKeySummary {
  id: string;
  name: string;
  keyPrefix: string;
  lastUsedAt: Date | null;
  createdAt: Date;
  revokedAt: Date | null;
}

@Injectable()
export class ApiKeyService {
  private readonly logger = new Logger(ApiKeyService.name);

  /** Prefix every generated key starts with, e.g. `mcpe_a1b2c3d4e5f6...`. */
  static readonly KEY_PREFIX = 'mcpe_';
  /** Max number of non-revoked keys a single user may hold at once. */
  static readonly MAX_ACTIVE_KEYS = 10;
  /** Only persist a `lastUsedAt` bump at most this often, to avoid write amplification. */
  static readonly LAST_USED_THROTTLE_MS = 60_000;

  constructor(
    @InjectRepository(ApiKey)
    private readonly apiKeyRepository: Repository<ApiKey>,
  ) {}

  /**
   * Generate a new API key for the given user.
   * Returns the full plaintext key - callers must persist/display it now,
   * since only its hash is stored and it can never be retrieved again.
   */
  async createKey(userId: string, name: string): Promise<CreatedApiKey> {
    const activeCount = await this.apiKeyRepository.count({
      where: { userId, revokedAt: IsNull() },
    });

    if (activeCount >= ApiKeyService.MAX_ACTIVE_KEYS) {
      throw new BadRequestException(
        `Maximum of ${ApiKeyService.MAX_ACTIVE_KEYS} active API keys reached. Revoke an existing key before creating a new one.`,
      );
    }

    const rawKey = this.generateRawKey();
    const keyHash = this.hashKey(rawKey);
    const keyPrefix = this.derivePrefix(rawKey);

    const entity = this.apiKeyRepository.create({
      userId,
      name,
      keyPrefix,
      keyHash,
    });

    const saved = await this.apiKeyRepository.save(entity);

    return {
      id: saved.id,
      name: saved.name,
      key: rawKey,
      keyPrefix: saved.keyPrefix,
      createdAt: saved.createdAt,
    };
  }

  /** List all keys (active and revoked) belonging to a user, newest first. */
  async listKeys(userId: string): Promise<ApiKeySummary[]> {
    const keys = await this.apiKeyRepository.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });

    return keys.map((key) => ({
      id: key.id,
      name: key.name,
      keyPrefix: key.keyPrefix,
      lastUsedAt: key.lastUsedAt ?? null,
      createdAt: key.createdAt,
      revokedAt: key.revokedAt ?? null,
    }));
  }

  /** Revoke a key owned by the user. Idempotent if already revoked. */
  async revokeKey(userId: string, keyId: string): Promise<void> {
    const key = await this.apiKeyRepository.findOne({ where: { id: keyId, userId } });

    if (!key) {
      throw new NotFoundException('API key not found');
    }

    if (key.revokedAt) {
      return;
    }

    key.revokedAt = new Date();
    await this.apiKeyRepository.save(key);
  }

  /**
   * Authenticate a raw API key presented on a request.
   * Returns the owning user's id if the key is valid and not revoked, else null.
   * Bumps `lastUsedAt`, throttled to at most once per LAST_USED_THROTTLE_MS.
   */
  async validateApiKey(rawKey: string): Promise<string | null> {
    if (!rawKey || !rawKey.startsWith(ApiKeyService.KEY_PREFIX)) {
      return null;
    }

    const keyHash = this.hashKey(rawKey);
    const key = await this.apiKeyRepository.findOne({
      where: { keyHash, revokedAt: IsNull() },
    });

    if (!key) {
      return null;
    }

    const now = Date.now();
    const lastUsedMs = key.lastUsedAt ? key.lastUsedAt.getTime() : 0;
    if (now - lastUsedMs > ApiKeyService.LAST_USED_THROTTLE_MS) {
      // Fire-and-forget style update, but awaited so failures surface in logs
      // rather than as unhandled rejections. Never blocks/denies the request.
      try {
        await this.apiKeyRepository.update(key.id, { lastUsedAt: new Date() });
      } catch (error) {
        this.logger.warn(`Failed to update lastUsedAt for API key ${key.id}: ${error}`);
      }
    }

    return key.userId;
  }

  private generateRawKey(): string {
    return `${ApiKeyService.KEY_PREFIX}${randomBytes(24).toString('hex')}`;
  }

  private hashKey(rawKey: string): string {
    return createHash('sha256').update(rawKey).digest('hex');
  }

  /** `mcpe_` + first 8 hex chars of the random portion, for display purposes. */
  private derivePrefix(rawKey: string): string {
    return rawKey.slice(0, ApiKeyService.KEY_PREFIX.length + 8);
  }
}
