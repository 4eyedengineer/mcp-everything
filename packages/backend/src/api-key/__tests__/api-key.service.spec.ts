/// <reference types="jest" />
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ApiKeyService } from '../api-key.service';
import { ApiKey } from '../../database/entities/api-key.entity';

describe('ApiKeyService', () => {
  let service: ApiKeyService;
  let mockRepository: any;

  const userId = 'user-123';

  beforeEach(async () => {
    mockRepository = {
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockImplementation((data) => ({ ...data })),
      save: jest.fn().mockImplementation(async (entity) => ({
        id: 'key-abc',
        createdAt: new Date('2026-07-29T00:00:00.000Z'),
        lastUsedAt: null,
        revokedAt: null,
        ...entity,
      })),
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [ApiKeyService, { provide: getRepositoryToken(ApiKey), useValue: mockRepository }],
    }).compile();

    service = module.get<ApiKeyService>(ApiKeyService);
  });

  describe('createKey', () => {
    it('generates a key in the mcpe_<hex> format and never returns it again', async () => {
      const result = await service.createKey(userId, 'My key');

      expect(result.key).toMatch(/^mcpe_[0-9a-f]{48}$/);
      expect(result.keyPrefix).toBe(result.key.slice(0, 13));
      expect(result.name).toBe('My key');
      expect(result.id).toBe('key-abc');
    });

    it('stores only a sha256 hash of the key, never the plaintext', async () => {
      await service.createKey(userId, 'My key');

      expect(mockRepository.create).toHaveBeenCalledTimes(1);
      const savedData = mockRepository.create.mock.calls[0][0];

      expect(savedData.keyHash).toMatch(/^[0-9a-f]{64}$/);
      expect(savedData).not.toHaveProperty('key');
    });

    it('rejects creating a key beyond the 10 active key limit', async () => {
      mockRepository.count.mockResolvedValue(10);

      await expect(service.createKey(userId, 'Eleventh key')).rejects.toThrow(BadRequestException);
      expect(mockRepository.save).not.toHaveBeenCalled();
    });

    it('allows creating a key when under the limit', async () => {
      mockRepository.count.mockResolvedValue(9);

      await expect(service.createKey(userId, 'Tenth key')).resolves.toBeDefined();
    });
  });

  describe('listKeys', () => {
    it('maps stored keys to summaries without leaking the hash', async () => {
      const now = new Date();
      mockRepository.find.mockResolvedValue([
        {
          id: 'key-1',
          userId,
          name: 'Key one',
          keyPrefix: 'mcpe_aaaaaaaa',
          keyHash: 'deadbeef',
          lastUsedAt: now,
          createdAt: now,
          revokedAt: null,
        },
      ]);

      const keys = await service.listKeys(userId);

      expect(keys).toHaveLength(1);
      expect(keys[0]).toEqual({
        id: 'key-1',
        name: 'Key one',
        keyPrefix: 'mcpe_aaaaaaaa',
        lastUsedAt: now,
        createdAt: now,
        revokedAt: null,
      });
      expect((keys[0] as any).keyHash).toBeUndefined();
    });
  });

  describe('revokeKey', () => {
    it('sets revokedAt on a key owned by the user', async () => {
      const key = { id: 'key-1', userId, revokedAt: null };
      mockRepository.findOne.mockResolvedValue(key);

      await service.revokeKey(userId, 'key-1');

      expect(mockRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'key-1', revokedAt: expect.any(Date) }),
      );
    });

    it('throws NotFoundException for a key not owned by the user (or missing)', async () => {
      mockRepository.findOne.mockResolvedValue(null);

      await expect(service.revokeKey(userId, 'missing-key')).rejects.toThrow(NotFoundException);
    });

    it('is idempotent when the key is already revoked', async () => {
      mockRepository.findOne.mockResolvedValue({ id: 'key-1', userId, revokedAt: new Date() });

      await service.revokeKey(userId, 'key-1');

      expect(mockRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('validateApiKey', () => {
    it('returns null for a key not in mcpe_ format', async () => {
      const result = await service.validateApiKey('not-a-valid-key');
      expect(result).toBeNull();
      expect(mockRepository.findOne).not.toHaveBeenCalled();
    });

    it('returns null when no matching non-revoked key exists', async () => {
      mockRepository.findOne.mockResolvedValue(null);
      const result = await service.validateApiKey('mcpe_' + 'a'.repeat(48));
      expect(result).toBeNull();
    });

    it('looks up by the sha256 hash of the presented key and returns the owning userId', async () => {
      const rawKey = 'mcpe_' + 'b'.repeat(48);
      const expectedHash = createHash('sha256').update(rawKey).digest('hex');
      mockRepository.findOne.mockResolvedValue({
        id: 'key-1',
        userId: 'owner-1',
        lastUsedAt: null,
        revokedAt: null,
      });

      const result = await service.validateApiKey(rawKey);

      expect(mockRepository.findOne).toHaveBeenCalledWith({
        where: { keyHash: expectedHash, revokedAt: expect.anything() },
      });
      expect(result).toBe('owner-1');
    });

    it('bumps lastUsedAt when it is stale (throttled)', async () => {
      const rawKey = 'mcpe_' + 'c'.repeat(48);
      mockRepository.findOne.mockResolvedValue({
        id: 'key-1',
        userId: 'owner-1',
        lastUsedAt: null,
        revokedAt: null,
      });

      await service.validateApiKey(rawKey);

      expect(mockRepository.update).toHaveBeenCalledWith(
        'key-1',
        expect.objectContaining({ lastUsedAt: expect.any(Date) }),
      );
    });

    it('does not bump lastUsedAt again within the throttle window', async () => {
      const rawKey = 'mcpe_' + 'd'.repeat(48);
      mockRepository.findOne.mockResolvedValue({
        id: 'key-1',
        userId: 'owner-1',
        lastUsedAt: new Date(), // just used
        revokedAt: null,
      });

      await service.validateApiKey(rawKey);

      expect(mockRepository.update).not.toHaveBeenCalled();
    });
  });
});
