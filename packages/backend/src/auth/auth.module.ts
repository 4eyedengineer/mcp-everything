import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { JwtModule, JwtModuleOptions } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { JwtRefreshStrategy } from './strategies/jwt-refresh.strategy';
import { LocalStrategy } from './strategies/local.strategy';
import { GitHubStrategy } from './strategies/github.strategy';
import { GoogleStrategy } from './strategies/google.strategy';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { GitHubAuthGuard } from './guards/github-auth.guard';
import { GoogleAuthGuard } from './guards/google-auth.guard';
import { UserModule } from '../user/user.module';
import { EmailModule } from '../email/email.module';
import { ApiKeyModule } from '../api-key/api-key.module';

@Module({
  imports: [
    UserModule,
    EmailModule,
    // JwtAuthGuard (provided below) needs ApiKeyService to authenticate
    // requests that present an X-API-Key / Bearer mcpe_... key instead of a JWT.
    ApiKeyModule,
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService): JwtModuleOptions => {
        // Parse the expiry string to seconds for type safety
        const expiryStr = configService.get<string>('JWT_EXPIRY', '15m');
        const expiresIn = parseExpiryToSeconds(expiryStr);
        return {
          secret: configService.get<string>('JWT_SECRET'),
          signOptions: {
            expiresIn,
          },
        };
      },
      inject: [ConfigService],
    }),
    // Rate limiting is configured globally in AppModule (ThrottlerModule.forRoot)
    // and enforced by the global ThrottlerGuard; the @Throttle() decorators on
    // AuthController tighten the limits for sensitive auth routes.
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtStrategy,
    JwtRefreshStrategy,
    LocalStrategy,
    GitHubStrategy,
    GoogleStrategy,
    JwtAuthGuard,
    GitHubAuthGuard,
    GoogleAuthGuard,
  ],
  exports: [AuthService, JwtAuthGuard, GitHubAuthGuard, GoogleAuthGuard, JwtModule],
})
export class AuthModule {}

/**
 * Parse time string (e.g., '15m', '1h', '7d') to seconds.
 */
function parseExpiryToSeconds(expiry: string): number {
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
