import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { TokenEncryptionService } from './token-encryption.service';

async function buildService(encryptionKey: string | undefined): Promise<TokenEncryptionService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      TokenEncryptionService,
      {
        provide: ConfigService,
        useValue: {
          get: jest.fn((key: string) => (key === 'TOKEN_ENCRYPTION_KEY' ? encryptionKey : undefined)),
        },
      },
    ],
  }).compile();

  return module.get(TokenEncryptionService);
}

const VALID_KEY = randomBytes(32).toString('hex');

describe('TokenEncryptionService', () => {
  describe('when TOKEN_ENCRYPTION_KEY is a valid 32-byte hex key', () => {
    it('reports isEnabled = true', async () => {
      const service = await buildService(VALID_KEY);
      expect(service.isEnabled).toBe(true);
    });

    it('round-trips a plaintext token through encrypt/decrypt', async () => {
      const service = await buildService(VALID_KEY);
      const plaintext = 'gho_supersecretaccesstoken1234567890';

      const encrypted = service.encrypt(plaintext);

      expect(encrypted).toBeDefined();
      expect(encrypted).not.toContain(plaintext);
      expect(service.decrypt(encrypted)).toBe(plaintext);
    });

    it('produces a different ciphertext each time (random IV)', async () => {
      const service = await buildService(VALID_KEY);
      const plaintext = 'gho_sametokeneverytime';

      const first = service.encrypt(plaintext);
      const second = service.encrypt(plaintext);

      expect(first).not.toEqual(second);
      expect(service.decrypt(first)).toBe(plaintext);
      expect(service.decrypt(second)).toBe(plaintext);
    });

    it('fails to decrypt (returns undefined, does not throw) when encrypted under a different key', async () => {
      const serviceA = await buildService(VALID_KEY);
      const serviceB = await buildService(randomBytes(32).toString('hex'));

      const encrypted = serviceA.encrypt('gho_secret');

      expect(serviceB.decrypt(encrypted)).toBeUndefined();
    });

    it('returns undefined (does not throw) for a malformed payload', async () => {
      const service = await buildService(VALID_KEY);
      expect(service.decrypt('not-a-valid-payload')).toBeUndefined();
      expect(service.decrypt('a.b')).toBeUndefined();
    });

    it('returns undefined for null/undefined input', async () => {
      const service = await buildService(VALID_KEY);
      expect(service.decrypt(undefined)).toBeUndefined();
      expect(service.decrypt(null)).toBeUndefined();
    });

    it('detects tampering via the GCM auth tag', async () => {
      const service = await buildService(VALID_KEY);
      const encrypted = service.encrypt('gho_secret')!;
      const [iv, tag, data] = encrypted.split('.');
      // Flip the ciphertext without recomputing the auth tag.
      const tamperedData = Buffer.from(data, 'base64');
      tamperedData[0] ^= 0xff;
      const tampered = [iv, tag, tamperedData.toString('base64')].join('.');

      expect(service.decrypt(tampered)).toBeUndefined();
    });
  });

  describe('when TOKEN_ENCRYPTION_KEY is absent or malformed', () => {
    it('reports isEnabled = false and encrypt() returns undefined when unset', async () => {
      const service = await buildService(undefined);
      expect(service.isEnabled).toBe(false);
      expect(service.encrypt('gho_secret')).toBeUndefined();
    });

    it('degrades gracefully (does not throw at construction) for a too-short key', async () => {
      const service = await buildService('deadbeef');
      expect(service.isEnabled).toBe(false);
      expect(service.encrypt('gho_secret')).toBeUndefined();
    });

    it('degrades gracefully for non-hex garbage', async () => {
      const service = await buildService('not-hex-at-all-!!!');
      expect(service.isEnabled).toBe(false);
    });

    it('decrypt() returns undefined rather than throwing when disabled', async () => {
      const service = await buildService(undefined);
      expect(service.decrypt('anything.at.all')).toBeUndefined();
    });
  });
});
