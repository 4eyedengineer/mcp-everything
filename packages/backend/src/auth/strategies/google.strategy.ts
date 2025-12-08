import { Injectable, Logger } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, Profile } from 'passport-google-oauth20';
import { ConfigService } from '@nestjs/config';

export interface GoogleProfile {
  id: string;
  email: string;
  firstName: string | undefined;
  lastName: string | undefined;
  displayName: string | undefined;
  photos: Array<{ value: string }>;
}

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  private readonly logger = new Logger(GoogleStrategy.name);

  constructor(private readonly configService: ConfigService) {
    super({
      clientID: configService.get<string>('GOOGLE_CLIENT_ID'),
      clientSecret: configService.get<string>('GOOGLE_CLIENT_SECRET'),
      callbackURL: configService.get<string>('GOOGLE_CALLBACK_URL'),
      scope: ['email', 'profile'],
    });
  }

  async validate(
    _accessToken: string,
    _refreshToken: string,
    profile: Profile,
  ): Promise<GoogleProfile> {
    const { id, emails, name, displayName, photos } = profile;
    const email = emails?.[0]?.value;

    if (!email) {
      this.logger.warn(`Google OAuth: No email found in profile for Google ID ${id}`);
      throw new Error('No email found in Google profile');
    }

    this.logger.log(`Google OAuth validated for user: ${email} (${id})`);

    return {
      id,
      email,
      firstName: name?.givenName,
      lastName: name?.familyName,
      displayName,
      photos: photos || [],
    };
  }
}
