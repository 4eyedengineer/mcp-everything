/// <reference types="jest" />
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { CredentialVaultService } from '../credential-vault.service';
import { UserCredential } from '../../database/entities/user-credential.entity';
import { TokenEncryptionService } from '../../common/token-encryption/token-encryption.service';

describe('CredentialVaultService', () => {
  let service: CredentialVaultService;
  let mockRepository: any;
  let mockTokenEncryptionService: any;

  const userId = 'user-123';

  beforeEach(async () => {
    mockRepository = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation((data) => ({ ...data })),
      save: jest.fn().mockImplementation(async (entity) => ({
        id: 'cred-abc',
        createdAt: new Date('2026-08-25T00:00:00.000Z'),
        updatedAt: new Date('2026-08-25T00:00:00.000Z'),
        lastUsedAt: null,
        ...entity,
      })),
      remove: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue({}),
    };

    mockTokenEncryptionService = {
      isEnabled: true,
      encrypt: jest.fn().mockReturnValue('iv.tag.ciphertext'),
      decrypt: jest.fn().mockReturnValue('decrypted-plaintext'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CredentialVaultService,
        { provide: getRepositoryToken(UserCredential), useValue: mockRepository },
        { provide: TokenEncryptionService, useValue: mockTokenEncryptionService },
      ],
    }).compile();

    service = module.get<CredentialVaultService>(CredentialVaultService);
  });

  describe('createCredential', () => {
    it('encrypts the value via TokenEncryptionService and never stores it raw', async () => {
      const result = await service.createCredential(userId, {
        name: 'GITHUB_TOKEN',
        value: 'ghp_supersecret',
        description: 'my token',
      });

      expect(mockTokenEncryptionService.encrypt).toHaveBeenCalledWith('ghp_supersecret');

      expect(mockRepository.create).toHaveBeenCalledTimes(1);
      const savedData = mockRepository.create.mock.calls[0][0];
      expect(savedData.valueEncrypted).toBe('iv.tag.ciphertext');
      expect(savedData).not.toHaveProperty('value');
      expect(JSON.stringify(savedData)).not.toContain('ghp_supersecret');

      expect(result.id).toBe('cred-abc');
      expect(result.name).toBe('GITHUB_TOKEN');
      expect(result).not.toHaveProperty('value');
      expect(result).not.toHaveProperty('valueEncrypted');
    });

    it('throws ConflictException when a credential with the same name already exists (pre-check)', async () => {
      mockRepository.findOne.mockResolvedValue({ id: 'existing', userId, name: 'GITHUB_TOKEN' });

      await expect(
        service.createCredential(userId, { name: 'GITHUB_TOKEN', value: 'x' }),
      ).rejects.toThrow(ConflictException);
      expect(mockRepository.save).not.toHaveBeenCalled();
    });

    it('throws ConflictException on a racing unique-violation from the database', async () => {
      const pgError = Object.assign(
        new QueryFailedError('insert', [], new Error('duplicate key')),
        { code: '23505' },
      );
      mockRepository.save.mockRejectedValue(pgError);

      await expect(
        service.createCredential(userId, { name: 'GITHUB_TOKEN', value: 'x' }),
      ).rejects.toThrow(ConflictException);
    });

    it('fails closed (throws, never stores) when encryption is disabled', async () => {
      mockTokenEncryptionService.isEnabled = false;

      await expect(
        service.createCredential(userId, { name: 'GITHUB_TOKEN', value: 'ghp_secret' }),
      ).rejects.toThrow();

      expect(mockRepository.save).not.toHaveBeenCalled();
      expect(mockRepository.create).not.toHaveBeenCalled();
    });
  });

  describe('listCredentials', () => {
    it('returns metadata only, never the encrypted or plaintext value', async () => {
      const now = new Date();
      mockRepository.find.mockResolvedValue([
        {
          id: 'cred-1',
          userId,
          name: 'GITHUB_TOKEN',
          description: 'note',
          valueEncrypted: 'iv.tag.ciphertext',
          createdAt: now,
          updatedAt: now,
          lastUsedAt: null,
        },
      ]);

      const credentials = await service.listCredentials(userId);

      expect(credentials).toHaveLength(1);
      expect(credentials[0]).toEqual({
        id: 'cred-1',
        name: 'GITHUB_TOKEN',
        description: 'note',
        createdAt: now,
        updatedAt: now,
        lastUsedAt: null,
      });
      expect((credentials[0] as any).valueEncrypted).toBeUndefined();
    });
  });

  describe('deleteCredential', () => {
    it('removes a credential owned by the user', async () => {
      const credential = { id: 'cred-1', userId };
      mockRepository.findOne.mockResolvedValue(credential);

      await service.deleteCredential(userId, 'cred-1');

      expect(mockRepository.remove).toHaveBeenCalledWith(credential);
    });

    it('throws NotFoundException when the credential does not exist or is not owned', async () => {
      mockRepository.findOne.mockResolvedValue(null);

      await expect(service.deleteCredential(userId, 'not-mine')).rejects.toThrow(
        NotFoundException,
      );
      expect(mockRepository.remove).not.toHaveBeenCalled();
    });
  });

  describe('resolveForDeploy', () => {
    it('maps ENV_VAR_NAME -> credential name into decrypted values and bumps lastUsedAt', async () => {
      mockRepository.find.mockResolvedValue([
        { id: 'cred-1', userId, name: 'GITHUB_TOKEN', valueEncrypted: 'enc-1' },
        { id: 'cred-2', userId, name: 'STRIPE_KEY', valueEncrypted: 'enc-2' },
      ]);
      mockTokenEncryptionService.decrypt.mockImplementation((payload: string) =>
        payload === 'enc-1' ? 'gh-secret' : 'stripe-secret',
      );

      const resolved = await service.resolveForDeploy(userId, {
        GITHUB_TOKEN: 'GITHUB_TOKEN',
        STRIPE_SECRET_KEY: 'STRIPE_KEY',
      });

      expect(resolved).toEqual({
        GITHUB_TOKEN: 'gh-secret',
        STRIPE_SECRET_KEY: 'stripe-secret',
      });
      expect(mockRepository.update).toHaveBeenCalledWith(
        expect.arrayContaining(['cred-1', 'cred-2']),
        expect.objectContaining({ lastUsedAt: expect.any(Date) }),
      );
    });

    it('returns an empty object with no lookups when refs is empty', async () => {
      const resolved = await service.resolveForDeploy(userId, {});

      expect(resolved).toEqual({});
      expect(mockRepository.find).not.toHaveBeenCalled();
    });

    it('throws naming the missing credential when a referenced name is not owned by the user', async () => {
      mockRepository.find.mockResolvedValue([]);

      await expect(
        service.resolveForDeploy(userId, { GITHUB_TOKEN: 'NOT_MINE' }),
      ).rejects.toThrow(/NOT_MINE/);
      expect(mockRepository.update).not.toHaveBeenCalled();
    });

    it('throws when decryption fails for a resolved credential', async () => {
      mockRepository.find.mockResolvedValue([
        { id: 'cred-1', userId, name: 'GITHUB_TOKEN', valueEncrypted: 'enc-1' },
      ]);
      mockTokenEncryptionService.decrypt.mockReturnValue(undefined);

      await expect(
        service.resolveForDeploy(userId, { GITHUB_TOKEN: 'GITHUB_TOKEN' }),
      ).rejects.toThrow(/GITHUB_TOKEN/);
      expect(mockRepository.update).not.toHaveBeenCalled();
    });
  });
});
