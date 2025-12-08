import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { UserService } from '../user/user.service';
import { User } from '../database/entities/user.entity';
import { RegisterDto } from './dto/register.dto';
import { TokenResponseDto } from './dto/token-response.dto';
import { JwtPayload } from './strategies/jwt.strategy';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly userService: UserService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Register a new user and return authentication tokens.
   */
  async register(dto: RegisterDto): Promise<TokenResponseDto> {
    this.logger.log(`Registering new user: ${dto.email}`);

    const user = await this.userService.createUser({
      email: dto.email,
      password: dto.password,
      firstName: dto.firstName,
      lastName: dto.lastName,
    });

    this.logger.log(`User registered successfully: ${user.id}`);
    return this.generateTokens(user);
  }

  /**
   * Authenticate a user with email and password.
   */
  async login(email: string, password: string): Promise<TokenResponseDto> {
    const user = await this.userService.findByEmail(email.toLowerCase());

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (!user.isActive) {
      throw new UnauthorizedException('User account is deactivated');
    }

    const isValid = await this.userService.validatePassword(user, password);

    if (!isValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    await this.userService.updateLastLogin(user.id);

    this.logger.log(`User logged in: ${user.id}`);
    return this.generateTokens(user);
  }

  /**
   * Validate user from local strategy (already validated by LocalStrategy).
   */
  async validateUser(user: User): Promise<TokenResponseDto> {
    await this.userService.updateLastLogin(user.id);
    this.logger.log(`User authenticated via local strategy: ${user.id}`);
    return this.generateTokens(user);
  }

  /**
   * Refresh authentication tokens using a valid refresh token.
   */
  async refreshTokens(userId: string): Promise<TokenResponseDto> {
    const user = await this.userService.findById(userId);

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    if (!user.isActive) {
      throw new UnauthorizedException('User account is deactivated');
    }

    this.logger.log(`Tokens refreshed for user: ${user.id}`);
    return this.generateTokens(user);
  }

  /**
   * Logout user - in a production system this would blacklist the refresh token.
   * For now, this is a no-op since we don't have a token blacklist.
   */
  async logout(userId: string): Promise<void> {
    // In a production system, you would:
    // 1. Add the refresh token to a blacklist (Redis)
    // 2. Or store valid refresh tokens in DB and delete on logout
    this.logger.log(`User logged out: ${userId}`);
  }

  /**
   * Get current user profile.
   */
  async getProfile(userId: string): Promise<User | null> {
    return this.userService.findById(userId);
  }

  /**
   * Validate OAuth user and return authentication tokens.
   * Creates new user or links to existing account.
   */
  async validateOAuthUser(data: {
    provider: 'github' | 'google';
    providerId: string;
    email: string | undefined;
    username?: string;
    firstName?: string;
    lastName?: string;
    accessToken?: string;
  }): Promise<TokenResponseDto> {
    this.logger.log(`OAuth validation for ${data.provider} user: ${data.providerId}`);

    // Find existing user by provider ID
    let user =
      data.provider === 'github'
        ? await this.userService.findByGithubId(data.providerId)
        : await this.userService.findByGoogleId(data.providerId);

    if (!user && data.email) {
      // Check if user exists by email
      user = await this.userService.findByEmail(data.email);

      if (user) {
        // Link OAuth account to existing user
        this.logger.log(`Linking ${data.provider} account to existing user: ${user.id}`);
        await this.userService.linkOAuthAccount(user.id, data.provider, data.providerId, data.username);
      }
    }

    if (!user) {
      // Create new user from OAuth
      this.logger.log(`Creating new user from ${data.provider} OAuth`);
      user = await this.userService.createUser({
        email: data.email || `${data.providerId}@${data.provider}.oauth`,
        firstName: data.firstName,
        lastName: data.lastName,
        githubId: data.provider === 'github' ? data.providerId : undefined,
        githubUsername: data.provider === 'github' ? data.username : undefined,
        googleId: data.provider === 'google' ? data.providerId : undefined,
      });
    }

    await this.userService.updateLastLogin(user.id);
    this.logger.log(`OAuth user authenticated: ${user.id}`);
    return this.generateTokens(user);
  }

  /**
   * Generate access and refresh tokens for a user.
   */
  generateTokens(user: User): TokenResponseDto {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      tier: user.tier,
    };

    const accessTokenExpiryStr = this.configService.get<string>('JWT_EXPIRY', '15m');
    const refreshTokenExpiryStr = this.configService.get<string>('JWT_REFRESH_EXPIRY', '7d');

    // Convert string expiry to seconds for type safety with JWT library
    const accessTokenExpirySecs = this.parseExpiryToSeconds(accessTokenExpiryStr);
    const refreshTokenExpirySecs = this.parseExpiryToSeconds(refreshTokenExpiryStr);

    const accessToken = this.jwtService.sign(payload, {
      expiresIn: accessTokenExpirySecs,
    });

    const refreshToken = this.jwtService.sign(payload, {
      secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
      expiresIn: refreshTokenExpirySecs,
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: accessTokenExpirySecs,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        tier: user.tier,
      },
    };
  }

  /**
   * Parse time string (e.g., '15m', '1h', '7d') to seconds.
   */
  private parseExpiryToSeconds(expiry: string): number {
    const match = expiry.match(/^(\d+)([smhd])$/);

    if (!match) {
      return 900; // Default 15 minutes
    }

    const value = parseInt(match[1], 10);
    const unit = match[2];

    switch (unit) {
      case 's':
        return value;
      case 'm':
        return value * 60;
      case 'h':
        return value * 60 * 60;
      case 'd':
        return value * 60 * 60 * 24;
      default:
        return 900;
    }
  }
}
