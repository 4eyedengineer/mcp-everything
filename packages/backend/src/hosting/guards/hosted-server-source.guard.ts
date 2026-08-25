import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { HostedServerSourceTokenService } from '../hosted-server-source-token.service';

export interface HostedServerSourceAuthContext {
  serverId: string;
  /** The HostedServerSourceToken row that matched. */
  sourceTokenId: string;
}

export type RequestWithHostedServerSourceAuth = Request & {
  hostedServerSourceAuth?: HostedServerSourceAuthContext;
};

/**
 * Authenticates a request to the source-download endpoint against one specific
 * hosted server.
 *
 * Runs after the global `JwtAuthGuard`, which has stepped aside for the
 * `mcpsrc_` bearer token because the route carries `@HostedServerSourceRoute()`.
 * This guard is what closes that deferral; without it the route would be open.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ACCEPTS ONLY A SOURCE TOKEN, WHERE THE GATEWAY GUARD ALSO ACCEPTS
 * THE OWNER'S SESSION
 * ---------------------------------------------------------------------------
 * `HostedServerGatewayGuard` deliberately accepts an owner session as well,
 * because without it a freshly deployed server would be unreachable from the
 * product that deployed it. That argument does not transfer:
 *
 *   - There is no missing capability to compensate for. An owner who wants
 *     their generated source already has it - the conversation endpoints and
 *     the Download action in the chat UI serve it from the same
 *     `state.generatedCode` this endpoint reads.
 *   - This endpoint's whole reason to exist is a machine-to-machine path. Every
 *     additional accepted credential kind is another way for source to leave
 *     the system, for no capability gained.
 *   - The published contract is `401` for a bad, expired, or missing token,
 *     full stop. Silently also honouring session JWTs would make the endpoint
 *     behave differently from its own documentation.
 *
 * So a valid session JWT reaches this guard (the global guard authenticated it
 * normally) and is rejected here, exactly like no credential at all.
 * ---------------------------------------------------------------------------
 */
@Injectable()
export class HostedServerSourceGuard implements CanActivate {
  private readonly logger = new Logger(HostedServerSourceGuard.name);

  constructor(private readonly sourceTokenService: HostedServerSourceTokenService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithHostedServerSourceAuth>();
    const serverId = request.params?.serverId;

    if (!serverId) {
      throw new UnauthorizedException('No hosted server was named in the request');
    }

    const presentedToken = this.extractSourceToken(request);

    if (!presentedToken) {
      throw new UnauthorizedException(
        `Hosted server '${serverId}' source requires a source token. Send it as ` +
          '"Authorization: Bearer mcpsrc_...".',
      );
    }

    // Returns null for unknown, revoked, expired, deleted-server and
    // wrong-server tokens alike - all one thing to the caller: this credential
    // does not open this server's source.
    const match = await this.sourceTokenService.verifyToken(serverId, presentedToken);

    if (!match) {
      // Logs no part of the presented token, not even a prefix: a rejected
      // credential is still a credential, and this line is written on exactly
      // the path an attacker controls.
      this.logger.warn(`Rejected source token for server ${serverId}`);
      throw new UnauthorizedException(
        `The source token presented is not valid for hosted server '${serverId}'. ` +
          'It may be revoked, expired, or issued for a different server.',
      );
    }

    request.hostedServerSourceAuth = { serverId, sourceTokenId: match.id };
    return true;
  }

  /**
   * An `mcpsrc_`-prefixed bearer token, if one was presented.
   *
   * Header only. The token is never accepted from a query string, because a
   * URL is written to access logs, proxy logs, browser history and `Referer`
   * headers, and this one grants read access to a user's private source.
   */
  private extractSourceToken(request: Request): string | null {
    const authHeader = request.headers['authorization'];
    if (typeof authHeader !== 'string') {
      return null;
    }

    const [scheme, token] = authHeader.split(' ');
    if (
      scheme?.toLowerCase() === 'bearer' &&
      token?.startsWith(HostedServerSourceTokenService.TOKEN_PREFIX)
    ) {
      return token;
    }

    return null;
  }
}
