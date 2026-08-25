import { Test, TestingModule } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import request from 'supertest';
import { HostingController } from './hosting.controller';
import { HostingService } from './hosting.service';
import { HostedServerApiKeyService } from './hosted-server-api-key.service';
import { User } from '../database/entities/user.entity';

/** Stands in for the global JwtAuthGuard so @CurrentUser() resolves in HTTP tests. */
@Injectable()
class StubAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    context.switchToHttp().getRequest().user = { id: 'user-1' };
    return true;
  }
}

describe('HostingController', () => {
  let controller: HostingController;
  let hostingService: { deployToCloud: jest.Mock };
  let apiKeyService: {
    createKey: jest.Mock;
    listKeys: jest.Mock;
    revokeKey: jest.Mock;
  };

  const user = { id: 'user-1' } as User;

  beforeEach(async () => {
    hostingService = { deployToCloud: jest.fn() };
    apiKeyService = {
      createKey: jest.fn(),
      listKeys: jest.fn(),
      revokeKey: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [HostingController],
      providers: [
        { provide: HostingService, useValue: hostingService },
        { provide: HostedServerApiKeyService, useValue: apiKeyService },
      ],
    }).compile();

    controller = module.get<HostingController>(HostingController);
  });

  describe('deployServer', () => {
    it('passes dto.envVars through to hostingService.deployToCloud (previously silently dropped)', async () => {
      hostingService.deployToCloud.mockResolvedValue({
        success: true,
        serverId: 'srv-1',
        endpointUrl: 'docker-exec://mcp-hosted-srv-1',
        status: 'running',
      });

      await controller.deployServer(user, 'conv-1', {
        envVars: { GITHUB_TOKEN: 'abc123' },
      });

      expect(hostingService.deployToCloud).toHaveBeenCalledWith('conv-1', 'user-1', {
        GITHUB_TOKEN: 'abc123',
      });
    });

    it('works with no envVars supplied', async () => {
      hostingService.deployToCloud.mockResolvedValue({
        success: true,
        serverId: 'srv-1',
        endpointUrl: 'https://srv-1.mcp.example.com',
        status: 'running',
      });

      await controller.deployServer(user, 'conv-1', {});

      expect(hostingService.deployToCloud).toHaveBeenCalledWith('conv-1', 'user-1', undefined);
    });
  });

  describe('API key endpoints', () => {
    const summary = {
      id: 'key-1',
      label: 'ci',
      keyPrefix: 'mcps_A1b2c3',
      lastFour: 'wxyz',
      createdAt: new Date('2026-01-01'),
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
      active: true,
    };

    it('returns the plaintext key plus an explicit shown-once warning on create', async () => {
      apiKeyService.createKey.mockResolvedValue({
        key: summary,
        plaintextKey: 'mcps_PLAINTEXT',
      });

      const result = await controller.createServerApiKey(user, 'srv-1', { label: 'ci' });

      expect(apiKeyService.createKey).toHaveBeenCalledWith('srv-1', 'user-1', {
        label: 'ci',
        expiresInDays: undefined,
      });
      expect(result.key).toBe('mcps_PLAINTEXT');
      expect(result.warning.shownOnce).toMatch(/only time/i);
      // The response must tell the caller how to actually present the key. The
      // old `notYetEnforced` warning ("nothing verifies it") was deleted rather
      // than reworded when the MCP gateway made it false.
      expect(result.warning.usage).toMatch(/authorization: bearer/i);
      expect(result.warning).not.toHaveProperty('notYetEnforced');
    });

    it('forwards an optional expiry', async () => {
      apiKeyService.createKey.mockResolvedValue({ key: summary, plaintextKey: 'mcps_X' });

      await controller.createServerApiKey(user, 'srv-1', { label: 'ci', expiresInDays: 30 });

      expect(apiKeyService.createKey).toHaveBeenCalledWith('srv-1', 'user-1', {
        label: 'ci',
        expiresInDays: 30,
      });
    });

    it('list returns metadata only - no secret field of any kind', async () => {
      apiKeyService.listKeys.mockResolvedValue([summary]);

      const result = await controller.listServerApiKeys(user, 'srv-1');

      expect(apiKeyService.listKeys).toHaveBeenCalledWith('srv-1', 'user-1');
      expect(result.apiKeys[0]).not.toHaveProperty('key');
      expect(result.apiKeys[0]).not.toHaveProperty('keyHash');
      expect(JSON.stringify(result)).not.toContain('mcps_PLAINTEXT');
    });

    it('scopes every key operation to the authenticated user, never a body/param-supplied id', async () => {
      apiKeyService.revokeKey.mockResolvedValue({
        ...summary,
        revokedAt: new Date(),
        active: false,
      });

      await controller.revokeServerApiKey(user, 'srv-1', 'key-1');

      expect(apiKeyService.revokeKey).toHaveBeenCalledWith('srv-1', 'key-1', 'user-1');
    });

    it("propagates the service 404 when the server is not the caller's", async () => {
      apiKeyService.listKeys.mockRejectedValue(new NotFoundException('Server not found: srv-9'));

      await expect(controller.listServerApiKeys(user, 'srv-9')).rejects.toThrow(NotFoundException);
    });
  });

  /**
   * Exercises the real ThrottlerGuard over HTTP so the @Throttle limit on the
   * deploy route is verified end-to-end rather than by reading the decorator.
   */
  describe('deploy rate limit', () => {
    let app: INestApplication;
    let throttledHostingService: { deployToCloud: jest.Mock; getServers: jest.Mock };

    beforeEach(async () => {
      throttledHostingService = {
        deployToCloud: jest.fn().mockResolvedValue({
          success: true,
          serverId: 'srv-1',
          endpointUrl: 'https://srv-1.mcp.example.com',
          status: 'running',
        }),
        getServers: jest.fn().mockResolvedValue([]),
      };

      const module: TestingModule = await Test.createTestingModule({
        imports: [
          // Mirrors app.module.ts: a generous global default, with the route's
          // own @Throttle tightening it.
          ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
        ],
        controllers: [HostingController],
        providers: [
          { provide: HostingService, useValue: throttledHostingService },
          { provide: HostedServerApiKeyService, useValue: apiKeyService },
          { provide: APP_GUARD, useClass: StubAuthGuard },
          { provide: APP_GUARD, useClass: ThrottlerGuard },
        ],
      }).compile();

      app = module.createNestApplication();
      await app.init();
    });

    afterEach(async () => {
      await app?.close();
    });

    it('allows 5 deploys per minute and rejects the 6th with 429', async () => {
      const server = app.getHttpServer();

      for (let i = 0; i < 5; i++) {
        const res = await request(server).post('/api/hosting/deploy/conv-1').send({});
        expect(res.status).toBe(201);
      }

      const blocked = await request(server).post('/api/hosting/deploy/conv-1').send({});

      expect(blocked.status).toBe(429);
      // The 6th request must never reach the (expensive) deploy path.
      expect(throttledHostingService.deployToCloud).toHaveBeenCalledTimes(5);
    });

    it('does not apply the strict deploy limit to read-only listing', async () => {
      const server = app.getHttpServer();

      for (let i = 0; i < 6; i++) {
        await request(server).post('/api/hosting/deploy/conv-1').send({});
      }

      // Listing uses the global default (100/min), so it still succeeds.
      const listed = await request(server).get('/api/hosting/servers');
      expect(listed.status).toBe(200);
    });
  });
});
