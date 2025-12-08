import { Injectable, Logger } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, Profile } from 'passport-github2';
import { ConfigService } from '@nestjs/config';

export interface GitHubProfile {
  id: string;
  username: string;
  email: string | undefined;
  displayName: string | undefined;
  photos: Array<{ value: string }>;
  accessToken: string;
}

@Injectable()
export class GitHubStrategy extends PassportStrategy(Strategy, 'github') {
  private readonly logger = new Logger(GitHubStrategy.name);

  constructor(private readonly configService: ConfigService) {
    super({
      clientID: configService.get<string>('GITHUB_CLIENT_ID'),
      clientSecret: configService.get<string>('GITHUB_CLIENT_SECRET'),
      callbackURL: configService.get<string>('GITHUB_CALLBACK_URL'),
      scope: ['user:email', 'read:user'],
    });
  }

  async validate(
    accessToken: string,
    _refreshToken: string,
    profile: Profile,
  ): Promise<GitHubProfile> {
    const { id, username, displayName, emails, photos } = profile;
    const email = emails?.[0]?.value;

    this.logger.log(`GitHub OAuth validated for user: ${username} (${id})`);

    return {
      id,
      username: username || '',
      email,
      displayName,
      photos: photos || [],
      accessToken,
    };
  }
}
