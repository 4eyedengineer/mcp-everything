/// <reference types="jest" />
import { Test, TestingModule } from '@nestjs/testing';
import { CredentialVaultController } from '../credential-vault.controller';
import { CredentialVaultService } from '../credential-vault.service';
import { User } from '../../database/entities/user.entity';

describe('CredentialVaultController', () => {
  let controller: CredentialVaultController;

  const mockService = {
    createCredential: jest.fn(),
    listCredentials: jest.fn(),
    deleteCredential: jest.fn(),
  };

  const user = { id: 'user-123' } as User;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [CredentialVaultController],
      providers: [{ provide: CredentialVaultService, useValue: mockService }],
    }).compile();

    controller = module.get<CredentialVaultController>(CredentialVaultController);
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('creates a credential and returns metadata plus a warning, never the plaintext value', async () => {
      const metadata = {
        id: 'cred-1',
        name: 'GITHUB_TOKEN',
        description: undefined,
        createdAt: new Date('2026-08-25T00:00:00.000Z'),
        updatedAt: new Date('2026-08-25T00:00:00.000Z'),
        lastUsedAt: null,
      };
      mockService.createCredential.mockResolvedValue(metadata);

      const dto = { name: 'GITHUB_TOKEN', value: 'ghp_supersecret', description: undefined };
      const result = await controller.create(user, dto as any);

      expect(mockService.createCredential).toHaveBeenCalledWith('user-123', {
        name: 'GITHUB_TOKEN',
        value: 'ghp_supersecret',
        description: undefined,
      });
      expect(result.credential).toEqual(metadata);
      expect(result.warning).toEqual(expect.any(String));

      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('ghp_supersecret');
    });
  });

  describe('list', () => {
    it('returns the credential metadata list for the current user', async () => {
      const credentials = [
        {
          id: 'cred-1',
          name: 'GITHUB_TOKEN',
          createdAt: new Date(),
          updatedAt: new Date(),
          lastUsedAt: null,
        },
      ];
      mockService.listCredentials.mockResolvedValue(credentials);

      const result = await controller.list(user);

      expect(mockService.listCredentials).toHaveBeenCalledWith('user-123');
      expect(result).toEqual({ credentials });
    });
  });

  describe('remove', () => {
    it('deletes a credential owned by the current user', async () => {
      mockService.deleteCredential.mockResolvedValue(undefined);

      const result = await controller.remove(user, 'cred-1');

      expect(mockService.deleteCredential).toHaveBeenCalledWith('user-123', 'cred-1');
      expect(result).toEqual({ success: true });
    });
  });
});
