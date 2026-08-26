import { Injectable, ConflictException, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { UserCredential } from '../database/entities/user-credential.entity';
import { TokenEncryptionService } from '../common/token-encryption/token-encryption.service';

// Postgres unique-violation SQLSTATE - raised if two requests race to create
// a credential with the same (userId, name) before the pre-check can catch it.
const PG_UNIQUE_VIOLATION = '23505';

/**
 * Metadata about a stored credential. Deliberately excludes `valueEncrypted`
 * (and, needless to say, any plaintext) - this is the only shape the vault
 * ever returns from a read path.
 */
export interface UserCredentialMetadata {
  id: string;
  name: string;
  description?: string;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt: Date | null;
}

export interface CreateCredentialInput {
  name: string;
  value: string;
  description?: string;
}

/**
 * Per-user encrypted credential vault.
 *
 * Stores secrets (a personal GITHUB_TOKEN, a Stripe key, etc.) a user wants
 * available for injection into a hosted MCP server they own. The plaintext
 * value is write-only: it is encrypted immediately on `createCredential` via
 * `TokenEncryptionService` (AES-256-GCM) and never appears in any return
 * value, log line, or error message from this service.
 *
 * `resolveForDeploy` is the seam the injection layer calls at deploy time to
 * turn a map of `ENV_VAR_NAME -> credential name` into the actual decrypted
 * values, scoped to the requesting user's own credentials only.
 */
@Injectable()
export class CredentialVaultService {
  private readonly logger = new Logger(CredentialVaultService.name);

  constructor(
    @InjectRepository(UserCredential)
    private readonly credentialRepository: Repository<UserCredential>,
    private readonly tokenEncryptionService: TokenEncryptionService,
  ) {}

  /**
   * Encrypt and store a new credential for `userId`.
   *
   * Fails closed: if `TokenEncryptionService` has no valid key configured,
   * this throws rather than ever persisting the value in plaintext.
   */
  async createCredential(
    userId: string,
    input: CreateCredentialInput,
  ): Promise<UserCredentialMetadata> {
    if (!this.tokenEncryptionService.isEnabled) {
      throw new Error(
        'Credential storage is disabled: TOKEN_ENCRYPTION_KEY is not configured. ' +
          'Refusing to store this credential rather than persist it unencrypted.',
      );
    }

    const existing = await this.credentialRepository.findOne({
      where: { userId, name: input.name },
    });
    if (existing) {
      throw new ConflictException(
        `A credential named "${input.name}" already exists. Choose a different name or delete the existing one first.`,
      );
    }

    const valueEncrypted = this.tokenEncryptionService.encrypt(input.value);
    if (!valueEncrypted) {
      // isEnabled was true above, so this is an unexpected encrypt-time
      // failure rather than a missing key - still must fail closed.
      throw new Error('Failed to encrypt credential value - credential was not stored.');
    }

    const entity = this.credentialRepository.create({
      userId,
      name: input.name,
      description: input.description ?? null,
      valueEncrypted,
    });

    try {
      const saved = await this.credentialRepository.save(entity);
      return this.toMetadata(saved);
    } catch (error) {
      if (
        error instanceof QueryFailedError &&
        (error as { code?: string }).code === PG_UNIQUE_VIOLATION
      ) {
        throw new ConflictException(
          `A credential named "${input.name}" already exists. Choose a different name or delete the existing one first.`,
        );
      }
      throw error;
    }
  }

  /** List metadata for all of a user's credentials, newest first. Never includes the value. */
  async listCredentials(userId: string): Promise<UserCredentialMetadata[]> {
    const credentials = await this.credentialRepository.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });

    return credentials.map((credential) => this.toMetadata(credential));
  }

  /** Delete a credential owned by the user. Throws if it doesn't exist or isn't theirs. */
  async deleteCredential(userId: string, id: string): Promise<void> {
    const credential = await this.credentialRepository.findOne({ where: { id, userId } });

    if (!credential) {
      throw new NotFoundException('Credential not found');
    }

    await this.credentialRepository.remove(credential);
  }

  /**
   * Resolve a map of `ENV_VAR_NAME -> credential name` into the decrypted
   * values, scoped to credentials owned by `userId`. Called by the injection
   * layer at deploy time.
   *
   * Throws naming the specific missing/undecryptable credential rather than
   * a generic error, so a user misconfiguring a deploy gets an actionable
   * message. Never logs the resolved values.
   */
  async resolveForDeploy(
    userId: string,
    refs: Record<string, string>,
  ): Promise<Record<string, string>> {
    const entries = Object.entries(refs);
    if (entries.length === 0) {
      return {};
    }

    const names = [...new Set(entries.map(([, credentialName]) => credentialName))];
    const owned = await this.credentialRepository.find({
      where: names.map((name) => ({ userId, name })),
    });
    const byName = new Map(owned.map((credential) => [credential.name, credential]));

    const resolved: Record<string, string> = {};
    const usedIds: string[] = [];

    for (const [envVarName, credentialName] of entries) {
      const credential = byName.get(credentialName);
      if (!credential) {
        throw new NotFoundException(
          `No credential named "${credentialName}" (referenced for ${envVarName}) was found for this user.`,
        );
      }

      const value = this.tokenEncryptionService.decrypt(credential.valueEncrypted);
      if (value === undefined) {
        throw new Error(
          `Failed to decrypt credential "${credentialName}" (referenced for ${envVarName}). ` +
            'It may have been encrypted with a different TOKEN_ENCRYPTION_KEY.',
        );
      }

      resolved[envVarName] = value;
      usedIds.push(credential.id);
    }

    // Best-effort last-used bump; never blocks or fails resolution.
    try {
      await this.credentialRepository.update(usedIds, { lastUsedAt: new Date() });
    } catch (error) {
      this.logger.warn(`Failed to update lastUsedAt for resolved credentials: ${error}`);
    }

    return resolved;
  }

  private toMetadata(credential: UserCredential): UserCredentialMetadata {
    return {
      id: credential.id,
      name: credential.name,
      description: credential.description ?? undefined,
      createdAt: credential.createdAt,
      updatedAt: credential.updatedAt,
      lastUsedAt: credential.lastUsedAt ?? null,
    };
  }
}
