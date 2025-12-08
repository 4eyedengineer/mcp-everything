import { ApiProperty } from '@nestjs/swagger';

export class UserResponseDto {
  @ApiProperty({ example: '123e4567-e89b-12d3-a456-426614174000' })
  id: string;

  @ApiProperty({ example: 'user@example.com' })
  email: string;

  @ApiProperty({ example: 'John', required: false })
  firstName?: string;

  @ApiProperty({ example: 'Doe', required: false })
  lastName?: string;

  @ApiProperty({ example: 'free', enum: ['free', 'pro', 'enterprise'] })
  tier: string;
}

export class TokenResponseDto {
  @ApiProperty({ description: 'JWT access token for API authentication' })
  accessToken: string;

  @ApiProperty({ description: 'JWT refresh token for obtaining new access tokens' })
  refreshToken: string;

  @ApiProperty({ example: 900, description: 'Access token expiry time in seconds' })
  expiresIn: number;

  @ApiProperty({ type: UserResponseDto, description: 'Authenticated user information' })
  user: UserResponseDto;
}

export class RefreshTokenDto {
  @ApiProperty({ description: 'The refresh token to exchange for new tokens' })
  refreshToken: string;
}
