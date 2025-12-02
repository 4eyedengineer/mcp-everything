import {
  Controller,
  Get,
  Patch,
  Delete,
  Body,
  HttpCode,
  HttpStatus,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { UserService } from './user.service';
import { UpdateAccountDto, AccountDto, UserProfileDto } from './dto/user.dto';
import { User } from '../database/entities/user.entity';

// TODO: Replace with proper auth guard once authentication is implemented
function getCurrentUser(req: Request): User | null {
  // For now, get user from a header or session
  // This will be replaced with proper JWT/session auth
  return (req as any).user || null;
}

@Controller('api/account')
export class AccountController {
  constructor(private readonly userService: UserService) {}

  @Get()
  async getAccount(@Req() req: Request): Promise<AccountDto> {
    const user = getCurrentUser(req);
    if (!user) {
      throw new UnauthorizedException('Not authenticated');
    }

    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      tier: user.tier,
      isEmailVerified: user.isEmailVerified,
      createdAt: user.createdAt,
    };
  }

  @Get('profile')
  async getProfile(@Req() req: Request): Promise<UserProfileDto> {
    const user = getCurrentUser(req);
    if (!user) {
      throw new UnauthorizedException('Not authenticated');
    }

    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      githubUsername: user.githubUsername,
      tier: user.tier,
      isEmailVerified: user.isEmailVerified,
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
    };
  }

  @Patch()
  @HttpCode(HttpStatus.OK)
  async updateAccount(
    @Req() req: Request,
    @Body() dto: UpdateAccountDto,
  ): Promise<AccountDto> {
    const user = getCurrentUser(req);
    if (!user) {
      throw new UnauthorizedException('Not authenticated');
    }

    const updated = await this.userService.updateUser(user.id, {
      firstName: dto.firstName,
      lastName: dto.lastName,
    });

    return {
      id: updated.id,
      email: updated.email,
      firstName: updated.firstName,
      lastName: updated.lastName,
      tier: updated.tier,
      isEmailVerified: updated.isEmailVerified,
      createdAt: updated.createdAt,
    };
  }

  @Delete()
  @HttpCode(HttpStatus.OK)
  async deleteAccount(@Req() req: Request): Promise<{ success: boolean }> {
    const user = getCurrentUser(req);
    if (!user) {
      throw new UnauthorizedException('Not authenticated');
    }

    await this.userService.deleteUser(user.id);
    return { success: true };
  }
}
