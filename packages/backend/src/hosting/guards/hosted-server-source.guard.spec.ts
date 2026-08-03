import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import {
  HostedServerSourceGuard,
  RequestWithHostedServerSourceAuth,
} from './hosted-server-source.guard';
import { HostedServerSourceTokenService } from '../hosted-server-source-token.service';

describe('HostedServerSourceGuard', () => {
  let guard: HostedServerSourceGuard;
  let sourceTokenService: { verifyToken: jest.Mock };

  function contextFor(request: Partial<RequestWithHostedServerSourceAuth>): ExecutionContext {
    return {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
  }

  function requestWithAuth(
    authorization?: string,
    serverId = 'srv-1',
  ): Partial<RequestWithHostedServerSourceAuth> {
    return {
      params: { serverId },
      headers: authorization ? { authorization } : {},
    } as Partial<RequestWithHostedServerSourceAuth>;
  }

  beforeEach(() => {
    sourceTokenService = { verifyToken: jest.fn() };
    guard = new HostedServerSourceGuard(
      sourceTokenService as unknown as HostedServerSourceTokenService,
    );
  });

  describe('accepts', () => {
    it('a valid source token for the named server', async () => {
      sourceTokenService.verifyToken.mockResolvedValue({ id: 'token-1' });
      const request = requestWithAuth('Bearer mcpsrc_good');

      await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
      expect(sourceTokenService.verifyToken).toHaveBeenCalledWith('srv-1', 'mcpsrc_good');
    });

    it('a lowercase "bearer" scheme, which HTTP treats as equivalent', async () => {
      sourceTokenService.verifyToken.mockResolvedValue({ id: 'token-1' });
      await expect(
        guard.canActivate(contextFor(requestWithAuth('bearer mcpsrc_good'))),
      ).resolves.toBe(true);
    });

    it('and records which token authorised the request, for the audit trail', async () => {
      sourceTokenService.verifyToken.mockResolvedValue({ id: 'token-42' });
      const request = requestWithAuth('Bearer mcpsrc_good');

      await guard.canActivate(contextFor(request));

      expect(request.hostedServerSourceAuth).toEqual({
        serverId: 'srv-1',
        sourceTokenId: 'token-42',
      });
    });
  });

  describe('rejects with 401', () => {
    it('a request with no Authorization header at all', async () => {
      await expect(guard.canActivate(contextFor(requestWithAuth()))).rejects.toThrow(
        UnauthorizedException,
      );
      expect(sourceTokenService.verifyToken).not.toHaveBeenCalled();
    });

    it('a token the service refuses (unknown, revoked, expired or wrong-server)', async () => {
      sourceTokenService.verifyToken.mockResolvedValue(null);
      await expect(
        guard.canActivate(contextFor(requestWithAuth('Bearer mcpsrc_bad'))),
      ).rejects.toThrow(UnauthorizedException);
    });

    /**
     * The gateway guard deliberately accepts an owner session as well, because
     * without it a deployed server would be unreachable from the product. That
     * argument does not transfer here - the owner already has their source via
     * the conversation endpoints - so every extra accepted credential kind
     * would be a new way for source to leave the system for no capability
     * gained. A session JWT reaches this guard authenticated and is still
     * refused.
     */
    it('a valid user session JWT - this endpoint is machine-to-machine only', async () => {
      const request = {
        ...requestWithAuth('Bearer eyJhbGciOiJIUzI1NiJ9.some.jwt'),
        user: { id: 'user-1' },
      } as Partial<RequestWithHostedServerSourceAuth>;

      await expect(guard.canActivate(contextFor(request))).rejects.toThrow(UnauthorizedException);
      expect(sourceTokenService.verifyToken).not.toHaveBeenCalled();
    });

    it('a hosted-server API key - an mcps_ key must not open the source endpoint', async () => {
      await expect(
        guard.canActivate(contextFor(requestWithAuth('Bearer mcps_a-gateway-key'))),
      ).rejects.toThrow(UnauthorizedException);
      expect(sourceTokenService.verifyToken).not.toHaveBeenCalled();
    });

    it('a platform API key - an mcpe_ key must not open the source endpoint either', async () => {
      await expect(
        guard.canActivate(contextFor(requestWithAuth('Bearer mcpe_a-platform-key'))),
      ).rejects.toThrow(UnauthorizedException);
      expect(sourceTokenService.verifyToken).not.toHaveBeenCalled();
    });

    it('a non-Bearer scheme carrying the right-looking value', async () => {
      await expect(
        guard.canActivate(contextFor(requestWithAuth('Basic mcpsrc_good'))),
      ).rejects.toThrow(UnauthorizedException);
      expect(sourceTokenService.verifyToken).not.toHaveBeenCalled();
    });

    it('a request that names no server', async () => {
      const request = { params: {}, headers: {} } as Partial<RequestWithHostedServerSourceAuth>;
      await expect(guard.canActivate(contextFor(request))).rejects.toThrow(UnauthorizedException);
    });
  });

  /**
   * A URL is written to access logs, proxy logs, browser history and Referer
   * headers. This token grants read access to a user's private source, so it
   * is accepted from the Authorization header and nowhere else.
   */
  it('never accepts the token from the query string', async () => {
    const request = {
      params: { serverId: 'srv-1' },
      headers: {},
      query: { token: 'mcpsrc_good' },
    } as unknown as Partial<RequestWithHostedServerSourceAuth>;

    await expect(guard.canActivate(contextFor(request))).rejects.toThrow(UnauthorizedException);
    expect(sourceTokenService.verifyToken).not.toHaveBeenCalled();
  });

  it('does not echo any part of a rejected token, in the error OR in the log', async () => {
    sourceTokenService.verifyToken.mockResolvedValue(null);
    const warn = jest
      .spyOn(guard['logger'], 'warn')
      .mockImplementation(() => undefined as unknown as void);

    let raised: Error | undefined;
    try {
      await guard.canActivate(contextFor(requestWithAuth('Bearer mcpsrc_supersecretvalue')));
    } catch (error) {
      raised = error as Error;
    }

    expect(raised).toBeInstanceOf(UnauthorizedException);
    expect(raised!.message).not.toContain('supersecretvalue');
    // Not even a prefix: this line is written on exactly the path an attacker
    // controls, and a rejected credential is still a credential.
    expect(raised!.message).not.toContain('mcpsrc_');

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toContain('supersecretvalue');
    expect(String(warn.mock.calls[0][0])).not.toContain('mcpsrc_');

    warn.mockRestore();
  });
});
