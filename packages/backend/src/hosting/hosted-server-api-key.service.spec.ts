import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { HostedServerApiKeyService } from './hosted-server-api-key.service';
import { HostedServerApiKey } from '../database/entities/hosted-server-api-key.entity';
import { HostedServer } from '../database/entities/hosted-server.entity';

/**
 * These tests run against an in-memory stand-in for the two repositories so
 * they exercise the real hashing/comparison/ownership logic rather than mocks
 * that assert on themselves.
 */
describe('HostedServerApiKeyService', () => {
  let service: HostedServerApiKeyService;
  let keyRows: HostedServerApiKey[];
  let servers: HostedServer[];

  const OWNER = 'user-a';
  const OTHER = 'user-b';

  const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

  function makeServer(serverId: string, userId: string | null): HostedServer {
    return { id: `row-${serverId}`, serverId, userId, status: 'running' } as HostedServer;
  }

  beforeEach(async () => {
    keyRows = [];
    servers = [
      makeServer('alpha-11111111', OWNER),
      makeServer('bravo-22222222', OWNER),
      makeServer('charlie-3333333', OTHER),
      makeServer('legacy-44444444', null),
    ];

    let nextId = 1;

    const apiKeyRepo = {
      create: (data: Partial<HostedServerApiKey>) => ({ ...data }) as HostedServerApiKey,
      save: jest.fn(async (entity: HostedServerApiKey) => {
        if (!entity.id) {
          entity.id = `key-${nextId++}`;
          entity.createdAt = new Date();
          keyRows.push(entity);
        }
        return entity;
      }),
      find: jest.fn(async (options: any) => {
        const { hostedServerId, revokedAt } = options.where;
        return keyRows.filter(
          (row) =>
            row.hostedServerId === hostedServerId &&
            (revokedAt === undefined || row.revokedAt === null || row.revokedAt === undefined),
        );
      }),
      findOne: jest.fn(async (options: any) => {
        const { id, hostedServerId } = options.where;
        return (
          keyRows.find((row) => row.id === id && row.hostedServerId === hostedServerId) ?? null
        );
      }),
      update: jest.fn(async (criteria: any, patch: Partial<HostedServerApiKey>) => {
        const row = keyRows.find((r) => r.id === criteria.id);
        if (row) Object.assign(row, patch);
        return { affected: row ? 1 : 0 };
      }),
    };

    const hostedServerRepo = {
      findOne: jest.fn(async (options: any) => {
        const { serverId, userId } = options.where;
        return (
          servers.find(
            (s) => s.serverId === serverId && (userId === undefined || s.userId === userId),
          ) ?? null
        );
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HostedServerApiKeyService,
        { provide: getRepositoryToken(HostedServerApiKey), useValue: apiKeyRepo },
        { provide: getRepositoryToken(HostedServer), useValue: hostedServerRepo },
      ],
    }).compile();

    service = module.get(HostedServerApiKeyService);
  });

  describe('createKey', () => {
    it('returns the plaintext key exactly once and persists only its SHA-256 hash', async () => {
      const created = await service.createKey('alpha-11111111', OWNER, { label: 'ci' });

      expect(created.plaintextKey).toMatch(/^mcps_[A-Za-z0-9_-]{43}$/);

      // Nothing in the stored row equals or contains the plaintext.
      const stored = keyRows[0];
      expect(stored.keyHash).toBe(sha256(created.plaintextKey));
      expect(JSON.stringify(stored)).not.toContain(created.plaintextKey);

      // ...and the metadata surface never carries it either.
      expect(JSON.stringify(created.key)).not.toContain(created.plaintextKey);
      expect(created.key).not.toHaveProperty('keyHash');
    });

    it('never returns the plaintext again from listKeys', async () => {
      const created = await service.createKey('alpha-11111111', OWNER, { label: 'ci' });

      const listed = await service.listKeys('alpha-11111111', OWNER);

      expect(listed).toHaveLength(1);
      expect(JSON.stringify(listed)).not.toContain(created.plaintextKey);
      expect(listed[0]).not.toHaveProperty('keyHash');
      expect(listed[0].keyPrefix).toBe(created.plaintextKey.slice(0, 11));
      expect(listed[0].lastFour).toBe(created.plaintextKey.slice(-4));
    });

    it('issues distinct keys every time', async () => {
      const a = await service.createKey('alpha-11111111', OWNER, { label: 'one' });
      const b = await service.createKey('alpha-11111111', OWNER, { label: 'two' });

      expect(a.plaintextKey).not.toBe(b.plaintextKey);
      expect(keyRows[0].keyHash).not.toBe(keyRows[1].keyHash);
    });

    it('rejects a blank label', async () => {
      await expect(
        service.createKey('alpha-11111111', OWNER, { label: '   ' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a non-positive expiry', async () => {
      await expect(
        service.createKey('alpha-11111111', OWNER, { label: 'ci', expiresInDays: 0 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('caps the number of simultaneously-active keys per server', async () => {
      for (let i = 0; i < HostedServerApiKeyService.MAX_ACTIVE_KEYS_PER_SERVER; i++) {
        await service.createKey('alpha-11111111', OWNER, { label: `key-${i}` });
      }

      await expect(
        service.createKey('alpha-11111111', OWNER, { label: 'one-too-many' }),
      ).rejects.toThrow(/maximum 5/i);
    });

    it('frees a slot when a key is revoked (rotation is possible)', async () => {
      const created: string[] = [];
      for (let i = 0; i < HostedServerApiKeyService.MAX_ACTIVE_KEYS_PER_SERVER; i++) {
        const key = await service.createKey('alpha-11111111', OWNER, { label: `key-${i}` });
        created.push(key.key.id);
      }

      await service.revokeKey('alpha-11111111', created[0], OWNER);

      await expect(
        service.createKey('alpha-11111111', OWNER, { label: 'replacement' }),
      ).resolves.toBeDefined();
    });
  });

  describe('verifyKey', () => {
    it('accepts a valid key', async () => {
      const created = await service.createKey('alpha-11111111', OWNER, { label: 'ci' });

      const match = await service.verifyKey('alpha-11111111', created.plaintextKey);

      expect(match).not.toBeNull();
      expect(match?.id).toBe(created.key.id);
    });

    it('stamps lastUsedAt on a successful verification', async () => {
      const created = await service.createKey('alpha-11111111', OWNER, { label: 'ci' });
      expect(keyRows[0].lastUsedAt).toBeNull();

      await service.verifyKey('alpha-11111111', created.plaintextKey);

      expect(keyRows[0].lastUsedAt).toBeInstanceOf(Date);
    });

    it('rejects a revoked key', async () => {
      const created = await service.createKey('alpha-11111111', OWNER, { label: 'ci' });
      await service.revokeKey('alpha-11111111', created.key.id, OWNER);

      await expect(service.verifyKey('alpha-11111111', created.plaintextKey)).resolves.toBeNull();
    });

    it('rejects an expired key', async () => {
      const created = await service.createKey('alpha-11111111', OWNER, {
        label: 'ci',
        expiresInDays: 1,
      });

      // Move the stored expiry into the past rather than sleeping.
      keyRows[0].expiresAt = new Date(Date.now() - 1000);

      await expect(service.verifyKey('alpha-11111111', created.plaintextKey)).resolves.toBeNull();
    });

    it("rejects a valid key presented against a different server", async () => {
      const created = await service.createKey('alpha-11111111', OWNER, { label: 'ci' });

      await expect(service.verifyKey('bravo-22222222', created.plaintextKey)).resolves.toBeNull();
    });

    it('rejects an unknown / malformed / empty key', async () => {
      await service.createKey('alpha-11111111', OWNER, { label: 'ci' });

      await expect(service.verifyKey('alpha-11111111', 'mcps_nope')).resolves.toBeNull();
      await expect(service.verifyKey('alpha-11111111', 'not-a-key')).resolves.toBeNull();
      await expect(service.verifyKey('alpha-11111111', '')).resolves.toBeNull();
    });

    it('rejects a key whose server has been deleted (soft delete leaves the rows behind)', async () => {
      const created = await service.createKey('alpha-11111111', OWNER, { label: 'ci' });
      servers[0].status = 'deleted';

      await expect(service.verifyKey('alpha-11111111', created.plaintextKey)).resolves.toBeNull();
    });

    it('rejects any key for an unknown server', async () => {
      const created = await service.createKey('alpha-11111111', OWNER, { label: 'ci' });

      await expect(service.verifyKey('no-such-server', created.plaintextKey)).resolves.toBeNull();
    });

    it('keeps other keys valid after one is revoked (zero-downtime rotation)', async () => {
      const oldKey = await service.createKey('alpha-11111111', OWNER, { label: 'old' });
      const newKey = await service.createKey('alpha-11111111', OWNER, { label: 'new' });

      // Both valid during the cutover window - the reason keys are a child
      // table rather than a column.
      await expect(service.verifyKey('alpha-11111111', oldKey.plaintextKey)).resolves.not.toBeNull();
      await expect(service.verifyKey('alpha-11111111', newKey.plaintextKey)).resolves.not.toBeNull();

      await service.revokeKey('alpha-11111111', oldKey.key.id, OWNER);

      await expect(service.verifyKey('alpha-11111111', oldKey.plaintextKey)).resolves.toBeNull();
      await expect(service.verifyKey('alpha-11111111', newKey.plaintextKey)).resolves.not.toBeNull();
    });
  });

  describe('ownership', () => {
    it('user B cannot create a key on user A\'s server', async () => {
      await expect(
        service.createKey('alpha-11111111', OTHER, { label: 'stolen' }),
      ).rejects.toThrow(NotFoundException);

      expect(keyRows).toHaveLength(0);
    });

    it('user B cannot list keys on user A\'s server', async () => {
      await service.createKey('alpha-11111111', OWNER, { label: 'ci' });

      await expect(service.listKeys('alpha-11111111', OTHER)).rejects.toThrow(NotFoundException);
    });

    it('user B cannot revoke a key on user A\'s server', async () => {
      const created = await service.createKey('alpha-11111111', OWNER, { label: 'ci' });

      await expect(
        service.revokeKey('alpha-11111111', created.key.id, OTHER),
      ).rejects.toThrow(NotFoundException);

      // Still usable by its rightful owner.
      await expect(service.verifyKey('alpha-11111111', created.plaintextKey)).resolves.not.toBeNull();
    });

    it('reports another user\'s server as not found rather than forbidden (no id probing)', async () => {
      // charlie belongs to OTHER; OWNER must not be able to tell it exists.
      await expect(service.listKeys('charlie-3333333', OWNER)).rejects.toThrow(
        /Server not found/,
      );
    });

    it('nobody can manage keys on an ownerless legacy server', async () => {
      await expect(
        service.createKey('legacy-44444444', OWNER, { label: 'x' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejects an empty userId outright', async () => {
      await expect(service.createKey('alpha-11111111', '', { label: 'x' })).rejects.toThrow();
    });
  });

  describe('revokeKey', () => {
    it('is idempotent and preserves the original revocation timestamp', async () => {
      const created = await service.createKey('alpha-11111111', OWNER, { label: 'ci' });

      const first = await service.revokeKey('alpha-11111111', created.key.id, OWNER);
      const second = await service.revokeKey('alpha-11111111', created.key.id, OWNER);

      expect(first.revokedAt).toEqual(second.revokedAt);
      expect(second.active).toBe(false);
    });

    it('404s for a key id that belongs to another server of the same user', async () => {
      const created = await service.createKey('alpha-11111111', OWNER, { label: 'ci' });

      await expect(
        service.revokeKey('bravo-22222222', created.key.id, OWNER),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
