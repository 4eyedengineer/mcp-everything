import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { HostedServerGatewayGuard } from './hosted-server-gateway.guard';
import { HostedServerApiKeyService } from '../hosted-server-api-key.service';
import { HostingService } from '../hosting.service';

describe('HostedServerGatewayGuard', () => {
  let guard: HostedServerGatewayGuard;
  let apiKeys: { verifyKey: jest.Mock };
  let hosting: { getServer: jest.Mock };

  const contextFor = (request: Record<string, unknown>): ExecutionContext =>
    ({
      switchToHttp: () => ({ getRequest: () => request }),
    }) as unknown as ExecutionContext;

  const requestWith = (
    headers: Record<string, string> = {},
    extra: Record<string, unknown> = {},
  ) => ({ params: { serverId: 'srv-1' }, headers, ...extra });

  beforeEach(async () => {
    apiKeys = { verifyKey: jest.fn() };
    hosting = { getServer: jest.fn().mockResolvedValue({ serverId: 'srv-1' }) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HostedServerGatewayGuard,
        { provide: HostedServerApiKeyService, useValue: apiKeys },
        { provide: HostingService, useValue: hosting },
      ],
    }).compile();

    guard = module.get(HostedServerGatewayGuard);
  });

  describe('per-server API key', () => {
    it('admits a valid mcps_ key and records how the caller authenticated', async () => {
      apiKeys.verifyKey.mockResolvedValue({ id: 'key-1' });
      const request = requestWith({ authorization: 'Bearer mcps_valid' });

      await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);

      // The first request-path caller of verifyKey() in the codebase.
      expect(apiKeys.verifyKey).toHaveBeenCalledWith('srv-1', 'mcps_valid');
      expect((request as Record<string, unknown>).hostedServerAuth).toEqual({
        kind: 'server-api-key',
        serverId: 'srv-1',
        apiKeyId: 'key-1',
      });
    });

    it('scopes verification to the server in the route, so another server’s key fails', async () => {
      // verifyKey() returns null for a key belonging to a different server.
      apiKeys.verifyKey.mockResolvedValue(null);

      await expect(
        guard.canActivate(contextFor(requestWith({ authorization: 'Bearer mcps_other' }))),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rejects a revoked or expired key (verifyKey returns null)', async () => {
      apiKeys.verifyKey.mockResolvedValue(null);

      await expect(
        guard.canActivate(contextFor(requestWith({ authorization: 'Bearer mcps_revoked' }))),
      ).rejects.toThrow(/not valid for hosted server 'srv-1'/);
    });

    it('never consults the owner path once an mcps_ key is presented', async () => {
      apiKeys.verifyKey.mockResolvedValue(null);

      await expect(
        guard.canActivate(
          contextFor(
            requestWith({ authorization: 'Bearer mcps_bad' }, { user: { id: 'user-1' } }),
          ),
        ),
      ).rejects.toThrow(UnauthorizedException);

      // A bad server key must not be silently upgraded by a session that
      // happens to be attached to the same request.
      expect(hosting.getServer).not.toHaveBeenCalled();
    });
  });

  describe('no credential', () => {
    it('rejects a request with no Authorization header at all', async () => {
      await expect(guard.canActivate(contextFor(requestWith()))).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('tells the caller exactly what to send', async () => {
      await expect(guard.canActivate(contextFor(requestWith()))).rejects.toThrow(
        /Authorization: Bearer mcps_/,
      );
    });

    it('rejects a non-bearer scheme', async () => {
      await expect(
        guard.canActivate(contextFor(requestWith({ authorization: 'Basic bWNwczpwdw==' }))),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('owner session', () => {
    it('admits the owner of the server', async () => {
      const request = requestWith({}, { user: { id: 'user-1' } });

      await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);

      expect(hosting.getServer).toHaveBeenCalledWith('srv-1', 'user-1');
      expect((request as Record<string, unknown>).hostedServerAuth).toEqual({
        kind: 'owner-session',
        serverId: 'srv-1',
        userId: 'user-1',
      });
    });

    it('rejects an authenticated user who does not own the server', async () => {
      // getServer(serverId, userId) reports someone else's server as not found,
      // so the gateway cannot be used to enumerate server ids.
      hosting.getServer.mockRejectedValue(new NotFoundException('Server not found: srv-1'));

      await expect(
        guard.canActivate(contextFor(requestWith({}, { user: { id: 'intruder' } }))),
      ).rejects.toThrow(NotFoundException);
    });
  });

  it('refuses a request that names no server', async () => {
    await expect(
      guard.canActivate(contextFor({ params: {}, headers: {} })),
    ).rejects.toThrow(UnauthorizedException);
  });
});
