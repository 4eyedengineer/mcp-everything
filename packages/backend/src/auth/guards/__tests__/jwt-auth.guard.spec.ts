/// <reference types="jest" />
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from '../jwt-auth.guard';
import { ApiKeyService } from '../../../api-key/api-key.service';
import { UserService } from '../../../user/user.service';
import { HostedServerSourceTokenService } from '../../../hosting/hosted-server-source-token.service';
import { HostedServerApiKeyService } from '../../../hosting/hosted-server-api-key.service';
import { IS_HOSTED_SERVER_SOURCE_KEY } from '../../decorators/hosted-server-source.decorator';
import { IS_HOSTED_SERVER_GATEWAY_KEY } from '../../decorators/hosted-server-gateway.decorator';

function makeContext(headers: Record<string, string>, isPublic = false) {
  const request: any = { headers };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;

  return { context, request };
}

describe('JwtAuthGuard (API key path)', () => {
  let guard: JwtAuthGuard;
  let reflector: Reflector;
  let apiKeyService: { validateApiKey: jest.Mock };
  let userService: { findById: jest.Mock };

  beforeEach(() => {
    reflector = new Reflector();
    apiKeyService = { validateApiKey: jest.fn() };
    userService = { findById: jest.fn() };
    guard = new JwtAuthGuard(reflector, apiKeyService as unknown as ApiKeyService, userService as unknown as UserService);
  });

  it('allows @Public() routes without checking any credentials', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const { context } = makeContext({});

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(apiKeyService.validateApiKey).not.toHaveBeenCalled();
  });

  it('authenticates via X-API-Key header and attaches the user to the request', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    const activeUser = { id: 'user-1', isActive: true, email: 'a@b.com' };
    apiKeyService.validateApiKey.mockResolvedValue('user-1');
    userService.findById.mockResolvedValue(activeUser);

    const { context, request } = makeContext({ 'x-api-key': 'mcpe_' + 'a'.repeat(48) });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(apiKeyService.validateApiKey).toHaveBeenCalledWith('mcpe_' + 'a'.repeat(48));
    expect(request.user).toBe(activeUser);
  });

  it('authenticates via Authorization: Bearer mcpe_... header', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    const activeUser = { id: 'user-2', isActive: true, email: 'b@b.com' };
    apiKeyService.validateApiKey.mockResolvedValue('user-2');
    userService.findById.mockResolvedValue(activeUser);

    const rawKey = 'mcpe_' + 'b'.repeat(48);
    const { context, request } = makeContext({ authorization: `Bearer ${rawKey}` });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(apiKeyService.validateApiKey).toHaveBeenCalledWith(rawKey);
    expect(request.user).toBe(activeUser);
  });

  it('rejects an invalid or revoked API key with 401', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    apiKeyService.validateApiKey.mockResolvedValue(null);

    const { context } = makeContext({ 'x-api-key': 'mcpe_' + 'z'.repeat(48) });

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects when the API key resolves to a deactivated user', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    apiKeyService.validateApiKey.mockResolvedValue('user-3');
    userService.findById.mockResolvedValue({ id: 'user-3', isActive: false });

    const { context } = makeContext({ 'x-api-key': 'mcpe_' + 'e'.repeat(48) });

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('does not treat a plain Bearer JWT as an API key and falls through to passport', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    // Bypass passport-jwt's real activation logic; only verifying that the
    // API-key short-circuit is NOT taken for a normal JWT.
    const superCanActivate = jest
      .spyOn(Object.getPrototypeOf(JwtAuthGuard.prototype), 'canActivate')
      .mockReturnValue(true as any);

    const { context } = makeContext({ authorization: 'Bearer some.jwt.token' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(apiKeyService.validateApiKey).not.toHaveBeenCalled();
    expect(superCanActivate).toHaveBeenCalled();

    superCanActivate.mockRestore();
  });
});

/**
 * The global guard defers - it does not skip - authentication for two
 * credential kinds that map to a SERVER rather than a user. Each is closed by a
 * mandatory route-level guard (HostedServerGatewayGuard,
 * HostedServerSourceGuard); what is tested here is only the deferral itself,
 * because a deferral that fires for the wrong route or the wrong prefix is an
 * open endpoint.
 */
describe('JwtAuthGuard (hosted-server credential deferral)', () => {
  let guard: JwtAuthGuard;
  let reflector: Reflector;
  let apiKeyService: { validateApiKey: jest.Mock };
  let userService: { findById: jest.Mock };

  /** Mock the reflector per metadata key, which the shared helper cannot do. */
  function markRoute(keys: Record<string, boolean>) {
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockImplementation((key: any) => keys[key as string] ?? false);
  }

  beforeEach(() => {
    reflector = new Reflector();
    apiKeyService = { validateApiKey: jest.fn() };
    userService = { findById: jest.fn() };
    guard = new JwtAuthGuard(
      reflector,
      apiKeyService as unknown as ApiKeyService,
      userService as unknown as UserService,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('defers an mcpsrc_ bearer on a source route WITHOUT authenticating a user', async () => {
    markRoute({ isHostedServerSource: true });
    const { context, request } = makeContext({ authorization: 'Bearer mcpsrc_abc' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    // The whole point of the deferral: no user was produced, so anything
    // downstream that needs one must get it from the route-level guard.
    expect(request.user).toBeUndefined();
    expect(apiKeyService.validateApiKey).not.toHaveBeenCalled();
  });

  it('does NOT defer an mcpsrc_ bearer on a route that is not a source route', async () => {
    markRoute({});
    const superCanActivate = jest
      .spyOn(Object.getPrototypeOf(JwtAuthGuard.prototype), 'canActivate')
      .mockReturnValue(true as any);

    const { context } = makeContext({ authorization: 'Bearer mcpsrc_abc' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    // Fell through to normal authentication rather than being waved past.
    expect(superCanActivate).toHaveBeenCalled();
  });

  it('does NOT defer a session JWT on a source route', async () => {
    markRoute({ isHostedServerSource: true });
    const superCanActivate = jest
      .spyOn(Object.getPrototypeOf(JwtAuthGuard.prototype), 'canActivate')
      .mockReturnValue(true as any);

    const { context } = makeContext({ authorization: 'Bearer some.jwt.token' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(superCanActivate).toHaveBeenCalled();
  });

  /**
   * The two deferrals must not cross-fire. `mcpsrc_` is not a string prefix of
   * `mcps_` (the 5th char is `r`, not `_`), which is what keeps a source token
   * from being routed to the gateway's guard and vice versa. Asserted here
   * because the prefixes are duplicated as literals in jwt-auth.guard.ts.
   */
  it('does not let an mcps_ gateway key be deferred as a source token', async () => {
    markRoute({ isHostedServerSource: true });
    const superCanActivate = jest
      .spyOn(Object.getPrototypeOf(JwtAuthGuard.prototype), 'canActivate')
      .mockReturnValue(true as any);

    const { context } = makeContext({ authorization: 'Bearer mcps_a-gateway-key' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(superCanActivate).toHaveBeenCalled();
  });

  it('does not let an mcpsrc_ source token be deferred as a gateway key', async () => {
    markRoute({ isHostedServerGateway: true });
    const superCanActivate = jest
      .spyOn(Object.getPrototypeOf(JwtAuthGuard.prototype), 'canActivate')
      .mockReturnValue(true as any);

    const { context } = makeContext({ authorization: 'Bearer mcpsrc_a-source-token' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(superCanActivate).toHaveBeenCalled();
  });

  /**
   * The literals in jwt-auth.guard.ts are duplicated from the services (so the
   * global guard need not depend on HostingModule). This is the assertion that
   * keeps the copies honest.
   */
  it('keeps the duplicated prefix literals in agreement with their services', () => {
    expect(HostedServerSourceTokenService.TOKEN_PREFIX).toBe('mcpsrc_');
    expect(HostedServerApiKeyService.KEY_PREFIX).toBe('mcps_');
    expect(IS_HOSTED_SERVER_SOURCE_KEY).toBe('isHostedServerSource');
    expect(IS_HOSTED_SERVER_GATEWAY_KEY).toBe('isHostedServerGateway');

    // Mutually non-overlapping, in both directions.
    expect(
      `${HostedServerSourceTokenService.TOKEN_PREFIX}x`.startsWith(
        HostedServerApiKeyService.KEY_PREFIX,
      ),
    ).toBe(false);
    expect(
      `${HostedServerApiKeyService.KEY_PREFIX}x`.startsWith(
        HostedServerSourceTokenService.TOKEN_PREFIX,
      ),
    ).toBe(false);
  });
});
