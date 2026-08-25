import { ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { Request } from 'express';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { IS_HOSTED_SERVER_GATEWAY_KEY } from '../decorators/hosted-server-gateway.decorator';
import { IS_HOSTED_SERVER_SOURCE_KEY } from '../decorators/hosted-server-source.decorator';
import { ApiKeyService } from '../../api-key/api-key.service';
import { UserService } from '../../user/user.service';

/**
 * Prefix of a per-hosted-server credential (`HostedServerApiKeyService.KEY_PREFIX`).
 * Duplicated as a literal rather than imported so the global auth guard does
 * not take a dependency on HostingModule; the two are asserted to agree by
 * `jwt-auth.guard.spec.ts`.
 */
const HOSTED_SERVER_KEY_PREFIX = 'mcps_';

/**
 * Prefix of a hosted-server source-fetch credential
 * (`HostedServerSourceTokenService.TOKEN_PREFIX`). Duplicated for the same
 * reason as above, and asserted to agree by `jwt-auth.guard.spec.ts`.
 *
 * Note this does NOT overlap `mcps_`: `'mcpsrc_x'.startsWith('mcps_')` is
 * false. The two prefix checks below are therefore mutually exclusive, which
 * is what keeps a gateway key from being routed as a source token.
 */
const HOSTED_SERVER_SOURCE_PREFIX = 'mcpsrc_';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(
    private reflector: Reflector,
    private apiKeyService: ApiKeyService,
    private userService: UserService,
  ) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Check if the route is marked as public
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();

    // Hosted-MCP gateway route carrying a per-server (`mcps_`) credential.
    // Authentication is DEFERRED, not skipped: HostedServerGatewayGuard runs
    // after this guard and verifies the key against the server named in the
    // route. Returning true here without setting `request.user` is what lets a
    // credential that maps to a *server* rather than a *user* through a guard
    // whose entire contract is to produce a user. See
    // `@HostedServerGatewayRoute()`.
    if (this.isHostedServerGatewayRoute(context) && this.hasHostedServerKey(request)) {
      return true;
    }

    // Hosted-server source route carrying a source token (`mcpsrc_`). Same
    // deferral as above and for the same reason - the credential maps to a
    // SERVER, not a user - closed by HostedServerSourceGuard, which is
    // mandatory on the route. See `@HostedServerSourceRoute()`.
    if (this.isHostedServerSourceRoute(context) && this.hasHostedServerSourceToken(request)) {
      return true;
    }

    // API key authentication (X-API-Key header, or Authorization: Bearer mcpe_...)
    // is checked first so a request carrying an API key never falls through
    // to (and fails) passport-jwt's bearer token parsing.
    const rawApiKey = this.extractApiKey(request);

    if (rawApiKey) {
      const userId = await this.apiKeyService.validateApiKey(rawApiKey);
      if (!userId) {
        throw new UnauthorizedException('Invalid or revoked API key');
      }

      const user = await this.userService.findById(userId);
      if (!user || !user.isActive) {
        throw new UnauthorizedException('Invalid or revoked API key');
      }

      // Attach the user in the same shape the JWT strategy's validate() does,
      // so downstream @CurrentUser() consumers behave identically either way.
      (request as any).user = user;
      return true;
    }

    return super.canActivate(context) as Promise<boolean>;
  }

  private isHostedServerGatewayRoute(context: ExecutionContext): boolean {
    return (
      this.reflector.getAllAndOverride<boolean>(IS_HOSTED_SERVER_GATEWAY_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) === true
    );
  }

  private isHostedServerSourceRoute(context: ExecutionContext): boolean {
    return (
      this.reflector.getAllAndOverride<boolean>(IS_HOSTED_SERVER_SOURCE_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) === true
    );
  }

  /** True when the request presents an `mcps_`-prefixed bearer token. */
  private hasHostedServerKey(request: Request): boolean {
    return this.hasBearerTokenWithPrefix(request, HOSTED_SERVER_KEY_PREFIX);
  }

  /** True when the request presents an `mcpsrc_`-prefixed bearer token. */
  private hasHostedServerSourceToken(request: Request): boolean {
    return this.hasBearerTokenWithPrefix(request, HOSTED_SERVER_SOURCE_PREFIX);
  }

  private hasBearerTokenWithPrefix(request: Request, prefix: string): boolean {
    const authHeader = request.headers['authorization'];
    if (typeof authHeader !== 'string') {
      return false;
    }
    const [scheme, token] = authHeader.split(' ');
    return scheme?.toLowerCase() === 'bearer' && !!token?.startsWith(prefix);
  }

  /** Extracts a raw `mcpe_...` API key from the X-API-Key header or an Authorization: Bearer header. */
  private extractApiKey(request: Request): string | null {
    const headerKey = request.headers['x-api-key'];
    if (typeof headerKey === 'string' && headerKey.startsWith(ApiKeyService.KEY_PREFIX)) {
      return headerKey;
    }

    const authHeader = request.headers['authorization'];
    if (typeof authHeader === 'string') {
      const [scheme, token] = authHeader.split(' ');
      if (scheme?.toLowerCase() === 'bearer' && token?.startsWith(ApiKeyService.KEY_PREFIX)) {
        return token;
      }
    }

    return null;
  }

  handleRequest<TUser = any>(err: any, user: TUser, info: any, context: ExecutionContext): TUser {
    // Check if the route is marked as public - allow anonymous access
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return user;
    }

    if (err || !user) {
      if (info?.name === 'TokenExpiredError') {
        throw new UnauthorizedException('Token has expired');
      }
      if (info?.name === 'JsonWebTokenError') {
        throw new UnauthorizedException('Invalid token');
      }
      throw err || new UnauthorizedException('Authentication required');
    }

    return user;
  }
}
