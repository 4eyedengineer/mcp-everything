import { IsEmail, IsString, IsOptional, MinLength, IsBoolean } from 'class-validator';

export class CreateUserDto {
  @IsEmail()
  email: string;

  @IsOptional()
  @IsString()
  @MinLength(8)
  password?: string;

  @IsOptional()
  @IsString()
  firstName?: string;

  @IsOptional()
  @IsString()
  lastName?: string;

  @IsOptional()
  @IsString()
  githubId?: string;

  @IsOptional()
  @IsString()
  githubUsername?: string;

  @IsOptional()
  @IsString()
  googleId?: string;
}

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  firstName?: string;

  @IsOptional()
  @IsString()
  lastName?: string;

  @IsOptional()
  @IsString()
  githubUsername?: string;
}

export class UpdateAccountDto {
  @IsOptional()
  @IsString()
  firstName?: string;

  @IsOptional()
  @IsString()
  lastName?: string;

  @IsOptional()
  @IsBoolean()
  emailNotifications?: boolean;
}

export interface AccountDto {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  tier: string;
  isEmailVerified: boolean;
  createdAt: Date;
}

export interface UserProfileDto {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  githubUsername?: string;
  tier: string;
  isEmailVerified: boolean;
  lastLoginAt?: Date;
  createdAt: Date;
}
