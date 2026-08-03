import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { HostedServerSourceTokenService } from './hosted-server-source-token.service';
import { HostedServerApiKeyService } from './hosted-server-api-key.service';
import { HostedServerSourceToken } from '../database/entities/hosted-server-source-token.entity';
import { HostedServer } from '../database/entities/hosted-server.entity';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

describe('HostedServerSourceTokenService', () => {
  let service: HostedServerSourceTokenService;
  let tokenRepo: {
    create: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
    update: jest.Mock;
  };
  let hostedServerRepo: { findOne: jest.Mock };
  let configValues: Record<string, unknown>;

  const SERVER_ROW = { id: 'hosted-uuid-1', status: 'running' };

  /** A stored row for a token whose plaintext is `plaintext`. */
  function storedToken(
    plaintext: string,
    overrides: Partial<HostedServerSourceToken> = {},
  ): HostedServerSourceToken {
    return {
      id: 'token-1',
      hostedServerId: SERVER_ROW.id,
      tokenHash: sha256(plaintext),
      tokenPrefix: plaintext.slice(0, 13),
      createdAt: new Date('2026-08-01T00:00:00Z'),
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
      lastUsedAt: null,
      useCount: 0,
      ...overrides,
    } as HostedServerSourceToken;
  }

  async function build(): Promise<HostedServerSourceTokenService> {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HostedServerSourceTokenService,
        { provide: getRepositoryToken(HostedServerSourceToken), useValue: tokenRepo },
        { provide: getRepositoryToken(HostedServer), useValue: hostedServerRepo },
        {
          provide: ConfigService,
          useValue: { get: jest.fn((key: string) => configValues[key]) },
        },
      ],
    }).compile();

    return module.get(HostedServerSourceTokenService);
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    configValues = {};

    tokenRepo = {
      create: jest.fn((data) => ({ ...data })),
      save: jest.fn(async (entity) => ({ id: 'token-1', ...entity })),
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ affected: 0 }),
    };
    hostedServerRepo = { findOne: jest.fn().mockResolvedValue(SERVER_ROW) };

    service = await build();
  });

  describe('token format', () => {
    it('issues a 256-bit base64url token behind the mcpsrc_ prefix', async () => {
      const minted = await service.mintToken(SERVER_ROW.id);

      expect(minted.token.startsWith('mcpsrc_')).toBe(true);
      const random = minted.token.slice('mcpsrc_'.length);
      expect(random).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes base64url
    });

    /**
     * Load-bearing, not cosmetic: JwtAuthGuard routes credentials by string
     * prefix. If `mcpsrc_` were a prefix of `mcps_` (or vice versa) a source
     * token could be routed to the MCP gateway's guard, or a gateway key to
     * this one, and each guard would then be asked to verify a credential kind
     * it knows nothing about.
     */
    it('cannot be confused with a hosted-server API key by prefix matching', async () => {
      const minted = await service.mintToken(SERVER_ROW.id);

      expect(minted.token.startsWith(HostedServerApiKeyService.KEY_PREFIX)).toBe(false);
      expect(`${HostedServerApiKeyService.KEY_PREFIX}abc`.startsWith('mcpsrc_')).toBe(false);
    });

    it('never returns the same token twice', async () => {
      const a = await service.mintToken(SERVER_ROW.id);
      const b = await service.mintToken(SERVER_ROW.id);
      expect(a.token).not.toBe(b.token);
    });
  });

  describe('storage', () => {
    it('persists only the SHA-256 hash, never the plaintext', async () => {
      const minted = await service.mintToken(SERVER_ROW.id);
      const persisted = tokenRepo.create.mock.calls[0][0];

      expect(persisted.tokenHash).toBe(sha256(minted.token));
      expect(JSON.stringify(persisted)).not.toContain(minted.token);
    });

    it('stores a non-secret display prefix that is not enough to reconstruct the token', async () => {
      const minted = await service.mintToken(SERVER_ROW.id);
      const persisted = tokenRepo.create.mock.calls[0][0];

      expect(minted.token.startsWith(persisted.tokenPrefix)).toBe(true);
      expect(persisted.tokenPrefix.length).toBeLessThan(minted.token.length / 2);
    });

    it('always sets an expiry - a source token may never be immortal', async () => {
      const before = Date.now();
      const minted = await service.mintToken(SERVER_ROW.id);

      expect(minted.expiresAt).toBeInstanceOf(Date);
      expect(minted.expiresAt.getTime()).toBeGreaterThan(before);
    });

    it('defaults to a 30-day lifetime', async () => {
      const minted = await service.mintToken(SERVER_ROW.id);
      const days = (minted.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
      expect(days).toBeCloseTo(30, 1);
    });

    it('honours HOSTED_SERVER_SOURCE_TOKEN_TTL_DAYS', async () => {
      configValues.HOSTED_SERVER_SOURCE_TOKEN_TTL_DAYS = '7';
      service = await build();

      const minted = await service.mintToken(SERVER_ROW.id);
      const days = (minted.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
      expect(days).toBeCloseTo(7, 1);
    });

    it.each(['0', '-1', 'not-a-number', '9999'])(
      'refuses to start with a nonsensical TTL of %s rather than quietly defaulting',
      async (ttl) => {
        configValues.HOSTED_SERVER_SOURCE_TOKEN_TTL_DAYS = ttl;
        await expect(build()).rejects.toThrow(BadRequestException);
      },
    );
  });

  /**
   * See DESIGN DECISION 3 on the service. One live token per server keeps the
   * blast radius of a leak bounded and makes revocation unambiguous.
   */
  describe('minting supersedes the previous token', () => {
    it('revokes the server existing live tokens', async () => {
      await service.mintToken(SERVER_ROW.id);

      expect(tokenRepo.update).toHaveBeenCalledWith(
        expect.objectContaining({ hostedServerId: SERVER_ROW.id }),
        expect.objectContaining({ revokedAt: expect.any(Date) }),
      );
    });

    it('revokes before it issues, so the two can never both be live', async () => {
      const order: string[] = [];
      tokenRepo.update.mockImplementation(async () => {
        order.push('revoke');
        return { affected: 1 };
      });
      tokenRepo.save.mockImplementation(async (entity) => {
        order.push('save');
        return { id: 'token-1', ...entity };
      });

      await service.mintToken(SERVER_ROW.id);

      expect(order).toEqual(['revoke', 'save']);
    });
  });

  describe('verifyToken', () => {
    it('accepts a live token for the right server', async () => {
      const plaintext = 'mcpsrc_valid-token';
      tokenRepo.find.mockResolvedValue([storedToken(plaintext)]);

      await expect(service.verifyToken('srv-1', plaintext)).resolves.toMatchObject({
        id: 'token-1',
      });
    });

    it('rejects an empty token without touching the database', async () => {
      await expect(service.verifyToken('srv-1', '')).resolves.toBeNull();
      expect(hostedServerRepo.findOne).not.toHaveBeenCalled();
    });

    it('rejects an unknown token', async () => {
      tokenRepo.find.mockResolvedValue([storedToken('mcpsrc_the-real-one')]);
      await expect(service.verifyToken('srv-1', 'mcpsrc_a-guess')).resolves.toBeNull();
    });

    it('rejects an expired token', async () => {
      const plaintext = 'mcpsrc_expired';
      tokenRepo.find.mockResolvedValue([
        storedToken(plaintext, { expiresAt: new Date(Date.now() - 1000) }),
      ]);

      await expect(service.verifyToken('srv-1', plaintext)).resolves.toBeNull();
    });

    it('treats an expiry of exactly now as expired', async () => {
      const now = new Date();
      jest.spyOn(global.Date, 'now').mockReturnValue(now.getTime());
      const plaintext = 'mcpsrc_boundary';
      tokenRepo.find.mockResolvedValue([storedToken(plaintext, { expiresAt: now })]);

      await expect(service.verifyToken('srv-1', plaintext)).resolves.toBeNull();
      jest.restoreAllMocks();
    });

    /**
     * Revoked rows are excluded by the query itself (`revokedAt: IsNull()`),
     * which is what this asserts - a revoked token is not merely filtered after
     * the fact, it is never a candidate.
     */
    it('never even considers a revoked token', async () => {
      tokenRepo.find.mockResolvedValue([]);

      await expect(service.verifyToken('srv-1', 'mcpsrc_revoked')).resolves.toBeNull();
      expect(tokenRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ hostedServerId: SERVER_ROW.id }),
        }),
      );
    });

    it('rejects a token issued for a different server', async () => {
      // The other server's token is simply not among this server's candidates.
      tokenRepo.find.mockResolvedValue([]);
      await expect(service.verifyToken('srv-2', 'mcpsrc_other-servers-token')).resolves.toBeNull();
    });

    it('rejects every token of an unknown server', async () => {
      hostedServerRepo.findOne.mockResolvedValue(null);
      await expect(service.verifyToken('nope', 'mcpsrc_anything')).resolves.toBeNull();
      expect(tokenRepo.find).not.toHaveBeenCalled();
    });

    it('rejects every token of a deleted server, whose rows outlive the soft delete', async () => {
      hostedServerRepo.findOne.mockResolvedValue({ id: 'hosted-uuid-1', status: 'deleted' });
      await expect(service.verifyToken('srv-1', 'mcpsrc_anything')).resolves.toBeNull();
      expect(tokenRepo.find).not.toHaveBeenCalled();
    });

    it('survives a corrupt (non-hex, wrong-length) stored hash rather than throwing', async () => {
      tokenRepo.find.mockResolvedValue([storedToken('mcpsrc_x', { tokenHash: 'garbage' })]);
      await expect(service.verifyToken('srv-1', 'mcpsrc_x')).resolves.toBeNull();
    });

    /**
     * See DESIGN DECISION 1. A pod restarts (CrashLoopBackOff, eviction, node
     * drain) and a Deployment scales; both re-fetch with the SAME token from
     * the same Secret. Single-use would wedge every restart after the first.
     */
    it('is redeemable repeatedly - a pod restart must not be locked out', async () => {
      const plaintext = 'mcpsrc_reusable';
      const row = storedToken(plaintext);
      tokenRepo.find.mockResolvedValue([row]);

      for (let i = 0; i < 5; i++) {
        await expect(service.verifyToken('srv-1', plaintext)).resolves.not.toBeNull();
      }
      expect(tokenRepo.update).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ revokedAt: expect.any(Date) }),
      );
    });

    it('records each use, so abnormal reuse of a leaked token is visible', async () => {
      const plaintext = 'mcpsrc_counted';
      tokenRepo.find.mockResolvedValue([storedToken(plaintext, { useCount: 4 })]);

      await service.verifyToken('srv-1', plaintext);

      expect(tokenRepo.update).toHaveBeenCalledWith(
        { id: 'token-1' },
        expect.objectContaining({ useCount: 5, lastUsedAt: expect.any(Date) }),
      );
    });

    it('does not deny a valid token because the usage bookkeeping failed', async () => {
      const plaintext = 'mcpsrc_bookkeeping';
      tokenRepo.find.mockResolvedValue([storedToken(plaintext)]);
      tokenRepo.update.mockRejectedValue(new Error('database is on fire'));

      await expect(service.verifyToken('srv-1', plaintext)).resolves.not.toBeNull();
    });
  });

  describe('revokeAllForServer', () => {
    it('revokes only the live tokens and reports how many', async () => {
      tokenRepo.update.mockResolvedValue({ affected: 3 });

      await expect(service.revokeAllForServer('hosted-uuid-1')).resolves.toBe(3);
      expect(tokenRepo.update).toHaveBeenCalledWith(
        expect.objectContaining({ hostedServerId: 'hosted-uuid-1' }),
        expect.objectContaining({ revokedAt: expect.any(Date) }),
      );
    });

    it('reports 0 rather than undefined when the driver returns no count', async () => {
      tokenRepo.update.mockResolvedValue({});
      await expect(service.revokeAllForServer('hosted-uuid-1')).resolves.toBe(0);
    });
  });
});
