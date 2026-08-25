import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Encrypts/decrypts small secrets (currently: a user's GitHub OAuth access
 * token) at rest, using AES-256-GCM with a dedicated key.
 *
 * Deliberately NOT the JWT signing secret (`JWT_SECRET`) - that key's job is
 * to sign/verify session tokens, and rotating it invalidates every logged-in
 * session. `TOKEN_ENCRYPTION_KEY` is a separate secret so it can be rotated
 * independently, and so a JWT_SECRET leak doesn't also expose stored GitHub
 * tokens (and vice versa).
 *
 * `TOKEN_ENCRYPTION_KEY` must be 64 hex characters (32 bytes, decoded) - see
 * packages/backend/.env.example for how to generate one.
 *
 * Fails gracefully, not at boot: if the key is absent or malformed,
 * `isEnabled` is false and `encrypt`/`decrypt` both return `undefined`
 * instead of throwing. Callers (AuthService, GitHubService) treat that the
 * same as "no token" - GitHub OAuth login itself still works, only
 * persistence of the token (and therefore per-user repo listing) is
 * disabled, with an honest message surfaced to the user rather than a
 * crashed process.
 */
@Injectable()
export class TokenEncryptionService {
  private readonly logger = new Logger(TokenEncryptionService.name);

  /** AES-256-GCM standard nonce size. */
  private static readonly IV_LENGTH_BYTES = 12;
  private static readonly ALGORITHM = 'aes-256-gcm';

  private readonly key: Buffer | undefined;

  constructor(configService: ConfigService) {
    const raw = configService.get<string>('TOKEN_ENCRYPTION_KEY');

    if (!raw) {
      this.logger.warn(
        'TOKEN_ENCRYPTION_KEY is not set - GitHub token storage is disabled. ' +
          'GitHub OAuth login still works, but the access token will not be ' +
          'persisted, so per-user repository listing is unavailable until this ' +
          'is configured.',
      );
      this.key = undefined;
      return;
    }

    let decoded: Buffer;
    try {
      decoded = Buffer.from(raw, 'hex');
    } catch {
      this.logger.error(
        'TOKEN_ENCRYPTION_KEY is not valid hex - GitHub token storage is disabled.',
      );
      this.key = undefined;
      return;
    }

    if (decoded.length !== 32) {
      this.logger.error(
        `TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes (64 hex characters) for ` +
          `AES-256-GCM; got ${decoded.length} bytes. GitHub token storage is disabled.`,
      );
      this.key = undefined;
      return;
    }

    this.key = decoded;
  }

  /** Whether a valid encryption key is configured. */
  get isEnabled(): boolean {
    return this.key !== undefined;
  }

  /**
   * Encrypt `plaintext`. Returns `undefined` (never throws) when no valid
   * key is configured - callers must treat that as "cannot persist this
   * secret right now" and degrade accordingly.
   *
   * Output format: `<iv>.<authTag>.<ciphertext>`, each segment base64.
   */
  encrypt(plaintext: string): string | undefined {
    if (!this.key) {
      return undefined;
    }

    const iv = randomBytes(TokenEncryptionService.IV_LENGTH_BYTES);
    const cipher = createCipheriv(TokenEncryptionService.ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return [iv, authTag, ciphertext].map((buf) => buf.toString('base64')).join('.');
  }

  /**
   * Decrypt a payload produced by `encrypt`. Returns `undefined` (never
   * throws) if no valid key is configured, the payload is malformed, or
   * decryption/authentication fails (e.g. the key was rotated) - never logs
   * the plaintext, ciphertext, or key material, only that a failure
   * occurred.
   */
  decrypt(payload: string | undefined | null): string | undefined {
    if (!this.key || !payload) {
      return undefined;
    }

    try {
      const [ivB64, tagB64, dataB64] = payload.split('.');
      if (!ivB64 || !tagB64 || !dataB64) {
        this.logger.warn('Stored encrypted token has an unexpected format - discarding');
        return undefined;
      }

      const iv = Buffer.from(ivB64, 'base64');
      const authTag = Buffer.from(tagB64, 'base64');
      const data = Buffer.from(dataB64, 'base64');

      const decipher = createDecipheriv(TokenEncryptionService.ALGORITHM, this.key, iv);
      decipher.setAuthTag(authTag);
      const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
      return plaintext.toString('utf8');
    } catch (error) {
      this.logger.warn(
        `Failed to decrypt a stored token (key rotated or data corrupted?): ${(error as Error).message}`,
      );
      return undefined;
    }
  }
}
