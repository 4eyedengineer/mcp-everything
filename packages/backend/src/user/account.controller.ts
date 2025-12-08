import {
  Controller,
  Get,
  Patch,
  Delete,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { UserService } from './user.service';
import { UpdateAccountDto, AccountDto, UserProfileDto } from './dto/user.dto';
import { User } from '../database/entities/user.entity';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

@Controller('api/account')
export class AccountController {
  constructor(private readonly userService: UserService) {}

  @Get()
  async getAccount(@CurrentUser() user: User): Promise<AccountDto> {
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
  async getProfile(@CurrentUser() user: User): Promise<UserProfileDto> {
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
    @CurrentUser() user: User,
    @Body() dto: UpdateAccountDto,
  ): Promise<AccountDto> {
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
  async deleteAccount(@CurrentUser() user: User): Promise<{ success: boolean }> {
    await this.userService.deleteUser(user.id);
    return { success: true };
  }
}
