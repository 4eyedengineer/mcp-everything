/// <reference types="jest" />
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from '../jwt-auth.guard';
import { ApiKeyService } from '../../../api-key/api-key.service';
import { UserService } from '../../../user/user.service';

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
