import { Injectable, Logger } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, Profile, VerifyCallback } from 'passport-google-oauth20';
import { ConfigService } from '@nestjs/config';
import { AuthService } from '../auth.service';

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  private readonly logger = new Logger(GoogleStrategy.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly authService: AuthService,
  ) {
    super({
      clientID: configService.get<string>('GOOGLE_CLIENT_ID'),
      clientSecret: configService.get<string>('GOOGLE_CLIENT_SECRET'),
      callbackURL: configService.get<string>('GOOGLE_CALLBACK_URL'),
      scope: ['email', 'profile'],
    });
  }

  async validate(
    accessToken: string,
    refreshToken: string,
    profile: Profile,
    done: VerifyCallback,
  ): Promise<void> {
    try {
      const { id, emails, name } = profile;
      const email = emails?.[0]?.value;

      if (!email) {
        this.logger.warn(`Google OAuth: No email found in profile for Google ID ${id}`);
        return done(new Error('No email found in Google profile'), undefined);
      }

      this.logger.log(`Google OAuth: Validating user ${email}`);

      const result = await this.authService.validateOAuthUser({
        provider: 'google',
        providerId: id,
        email,
        firstName: name?.givenName,
        lastName: name?.familyName,
      });

      done(null, result);
    } catch (error) {
      this.logger.error(`Google OAuth validation failed: ${error}`);
      done(error as Error, undefined);
    }
  }
}
