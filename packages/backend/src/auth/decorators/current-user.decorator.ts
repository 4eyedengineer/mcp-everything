import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { User } from '../../database/entities/user.entity';

/**
 * Decorator to extract the current authenticated user from the request.
 *
 * Usage:
 * @Get('profile')
 * async getProfile(@CurrentUser() user: User) {
 *   return user;
 * }
 *
 * @Get('email')
 * async getEmail(@CurrentUser('email') email: string) {
 *   return email;
 * }
 */
export const CurrentUser = createParamDecorator(
  (data: keyof User | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    const user = request.user as User;

    if (!user) {
      return null;
    }

    return data ? user[data] : user;
  },
);
