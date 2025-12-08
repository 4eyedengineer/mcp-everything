import {
  Controller,
  Post,
  Get,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiBody,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { TokenResponseDto, RefreshTokenDto } from './dto/token-response.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { JwtRefreshGuard } from './guards/jwt-refresh.guard';
import { LocalAuthGuard } from './guards/local-auth.guard';
import { GitHubAuthGuard } from './guards/github-auth.guard';
import { CurrentUser } from './decorators/current-user.decorator';
import { Public } from './decorators/public.decorator';
import { User } from '../database/entities/user.entity';
import { GitHubProfile } from './strategies/github.strategy';

@ApiTags('Authentication')
@Controller('api/v1/auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {}

  @Post('register')
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } }) // 5 requests per minute
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Register a new user' })
  @ApiResponse({
    status: 201,
    description: 'User registered successfully',
    type: TokenResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Invalid input data' })
  @ApiResponse({ status: 409, description: 'User with this email already exists' })
  @ApiResponse({ status: 429, description: 'Too many requests' })
  async register(@Body() dto: RegisterDto): Promise<TokenResponseDto> {
    return this.authService.register(dto);
  }

  @Post('login')
  @Public()
  @UseGuards(LocalAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60000 } }) // 10 requests per minute
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login with email and password' })
  @ApiBody({ type: LoginDto })
  @ApiResponse({
    status: 200,
    description: 'Login successful',
    type: TokenResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  @ApiResponse({ status: 429, description: 'Too many requests' })
  async login(
    @CurrentUser() user: User,
    @Body() _dto: LoginDto,
  ): Promise<TokenResponseDto> {
    // LocalAuthGuard already validated the user
    return this.authService.validateUser(user);
  }

  @Post('refresh')
  @Public()
  @UseGuards(JwtRefreshGuard)
  @Throttle({ default: { limit: 20, ttl: 60000 } }) // 20 requests per minute
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh access token' })
  @ApiBody({ type: RefreshTokenDto })
  @ApiResponse({
    status: 200,
    description: 'Tokens refreshed successfully',
    type: TokenResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Invalid or expired refresh token' })
  @ApiResponse({ status: 429, description: 'Too many requests' })
  async refresh(
    @CurrentUser() user: User,
    @Body() _dto: RefreshTokenDto,
  ): Promise<TokenResponseDto> {
    return this.authService.refreshTokens(user.id);
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Logout current user' })
  @ApiResponse({ status: 204, description: 'Logout successful' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async logout(@CurrentUser() user: User): Promise<void> {
    return this.authService.logout(user.id);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user profile' })
  @ApiResponse({
    status: 200,
    description: 'Current user profile',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        email: { type: 'string', format: 'email' },
        firstName: { type: 'string', nullable: true },
        lastName: { type: 'string', nullable: true },
        tier: { type: 'string', enum: ['free', 'pro', 'enterprise'] },
        isEmailVerified: { type: 'boolean' },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getProfile(@CurrentUser() user: User) {
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

  @Get('github')
  @Public()
  @UseGuards(GitHubAuthGuard)
  @ApiOperation({ summary: 'Initiate GitHub OAuth flow' })
  @ApiResponse({ status: 302, description: 'Redirects to GitHub for authentication' })
  async githubAuth() {
    // Initiates GitHub OAuth flow - handled by GitHubAuthGuard
  }

  @Get('github/callback')
  @Public()
  @UseGuards(GitHubAuthGuard)
  @ApiOperation({ summary: 'GitHub OAuth callback' })
  @ApiResponse({ status: 302, description: 'Redirects to frontend with tokens' })
  @ApiResponse({ status: 401, description: 'GitHub authentication failed' })
  async githubAuthCallback(
    @CurrentUser() profile: GitHubProfile,
    @Res() res: Response,
  ) {
    const tokens = await this.authService.validateOAuthUser({
      provider: 'github',
      providerId: profile.id,
      email: profile.email,
      username: profile.username,
      accessToken: profile.accessToken,
    });

    // Redirect to frontend with tokens as query parameters
    const frontendUrl = this.configService.get<string>('FRONTEND_URL', 'http://localhost:4200');
    res.redirect(
      `${frontendUrl}/auth/callback?token=${tokens.accessToken}&refresh=${tokens.refreshToken}`,
    );
  }
}
