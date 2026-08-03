import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { HostedServerApiKeyService } from '../hosted-server-api-key.service';
import { HostingService } from '../hosting.service';
import { User } from '../../database/entities/user.entity';

/** How a gateway request proved it was allowed through. Attached to the request. */
export type HostedServerAuthKind = 'server-api-key' | 'owner-session';

export interface HostedServerAuthContext {
  kind: HostedServerAuthKind;
  serverId: string;
  /** Set for 'server-api-key' - the HostedServerApiKey row that matched. */
  apiKeyId?: string;
  /** Set for 'owner-session'. */
  userId?: string;
}

export type RequestWithHostedServerAuth = Request & {
  hostedServerAuth?: HostedServerAuthContext;
  user?: User;
};

/**
 * Authenticates a request to the hosted-MCP gateway against one specific server.
 *
 * Runs after the global `JwtAuthGuard`, which has already either (a) stepped
 * aside for an `mcps_` bearer token because the route carries
 * `@HostedServerGatewayRoute()`, or (b) authenticated the caller normally and
 * populated `request.user`. This guard closes whichever of those two cases
 * applies; it never leaves a request unauthenticated.
 *
 * ---------------------------------------------------------------------------
 * WHY THE OWNER'S NORMAL SESSION IS ACCEPTED AS WELL
 * ---------------------------------------------------------------------------
 * This was a real decision, not a convenience default:
 *
 * FOR: there is no frontend UI for minting per-server keys yet (see the report
 * accompanying this change). Without a session path, a server the user just
 * deployed would be unreachable from the product that deployed it - the owner
 * could see it listed, read its logs and delete it, but could not send it a
 * single MCP request without dropping to curl. That is a worse security
 * outcome in practice, because the workaround is to mint a long-lived key and
 * paste it somewhere.
 *
 * AGAINST, and why each is acceptable here:
 *   - Breadth of credential. A session JWT is broader than a per-server key.
 *     But it grants no NEW authority: the same session can already stop, start,
 *     delete and read the logs of this exact server. Reaching its MCP endpoint
 *     is strictly less power than deleting it.
 *   - CSRF. This would be the serious objection if the platform authenticated
 *     with cookies, since `@All` accepts POST and a hostile page could drive
 *     the browser at the gateway. It does not: auth is an `Authorization:
 *     Bearer` header set explicitly by the Angular auth interceptor
 *     (packages/frontend/src/app/core/interceptors/auth.interceptor.ts), and a
 *     cross-origin page cannot attach it.
 *   - Attribution. Session traffic is still counted by `trackRequest`, and the
 *     `kind` recorded on the request distinguishes the two paths for anything
 *     that later needs to bill or audit them differently.
 *
 * Ownership is enforced either way: a session that does not own the server is
 * rejected exactly as if the server did not exist.
 * ---------------------------------------------------------------------------
 */
@Injectable()
export class HostedServerGatewayGuard implements CanActivate {
  private readonly logger = new Logger(HostedServerGatewayGuard.name);

  constructor(
    private readonly hostedServerApiKeyService: HostedServerApiKeyService,
    private readonly hostingService: HostingService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithHostedServerAuth>();
    const serverId = request.params?.serverId;

    if (!serverId) {
      throw new UnauthorizedException('No hosted server was named in the request');
    }

    const presentedKey = this.extractServerKey(request);

    if (presentedKey) {
      // The first request-path caller of verifyKey() in this codebase. It
      // returns null for unknown, revoked, expired, deleted-server, and
      // wrong-server keys alike - all of which are one thing to the caller:
      // this credential does not open this server.
      const match = await this.hostedServerApiKeyService.verifyKey(serverId, presentedKey);

      if (!match) {
        this.logger.warn(`Rejected hosted-server API key for server ${serverId}`);
        throw new UnauthorizedException(
          `The API key presented is not valid for hosted server '${serverId}'. ` +
            'It may be revoked, expired, or issued for a different server.',
        );
      }

      // verifyKey() already updated lastUsedAt on the matching row.
      request.hostedServerAuth = {
        kind: 'server-api-key',
        serverId,
        apiKeyId: match.id,
      };
      return true;
    }

    // No `mcps_` key: the global guard must have authenticated a platform
    // identity, or we would not be here.
    const user = request.user;
    if (!user?.id) {
      throw new UnauthorizedException(
        `Hosted server '${serverId}' requires an API key. Send it as ` +
          '"Authorization: Bearer mcps_...", or call as the server owner with a session token.',
      );
    }

    // Throws NotFoundException for a server that exists but belongs to someone
    // else, so the gateway cannot be used to probe for other users' server ids.
    await this.hostingService.getServer(serverId, user.id);

    request.hostedServerAuth = { kind: 'owner-session', serverId, userId: user.id };
    return true;
  }

  /** An `mcps_`-prefixed bearer token, if one was presented. */
  private extractServerKey(request: Request): string | null {
    const authHeader = request.headers['authorization'];
    if (typeof authHeader !== 'string') {
      return null;
    }

    const [scheme, token] = authHeader.split(' ');
    if (
      scheme?.toLowerCase() === 'bearer' &&
      token?.startsWith(HostedServerApiKeyService.KEY_PREFIX)
    ) {
      return token;
    }

    return null;
  }
}
