import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { User } from '../../database/entities/user.entity';

/**
 * AdminGuard
 *
 * INTERIM authorization mechanism for marketplace admin actions.
 *
 * There is currently no `role` column on the `User` entity (only a billing
 * `tier`: free/pro/enterprise) and no `@Roles()`/RolesGuard mechanism exists
 * anywhere else in the backend to reuse. Adding a proper role column/migration
 * is out of scope for this change, so admin access is gated by a static email
 * allowlist read from the `ADMIN_USER_EMAILS` env var (comma-separated,
 * case-insensitive) - see .env.example.
 *
 * This guard must run after JwtAuthGuard (the global APP_GUARD) so
 * `request.user` is already populated. It does not itself perform
 * authentication - only the allowlist check.
 *
 * TODO: replace with a real `role` column + RolesGuard once one exists.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user = request.user as User | undefined;

    if (!user?.email) {
      throw new ForbiddenException('Admin access requires authentication');
    }

    const allowlist = (this.configService.get<string>('ADMIN_USER_EMAILS') || '')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean);

    if (allowlist.length === 0 || !allowlist.includes(user.email.toLowerCase())) {
      throw new ForbiddenException('Admin access required');
    }

    return true;
  }
}
