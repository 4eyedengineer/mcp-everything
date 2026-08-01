import { Injectable, Logger } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, Profile } from 'passport-github2';
import { ConfigService } from '@nestjs/config';

/**
 * OAuth scope requested when a user connects their GitHub account (used
 * both by the strategy below and persisted alongside the encrypted token by
 * AuthService#validateOAuthUser - see database/entities/user.entity.ts
 * `githubTokenScope`).
 *
 * `public_repo` (NOT the unscoped `repo`) grants read/write on the user's
 * PUBLIC repositories only. That is deliberately more than this feature
 * strictly needs (it only reads), but it is the narrowest stock GitHub OAuth
 * scope that covers "list and read a user's public repos" - the unscoped
 * `repo` would additionally grant read/write on ALL of the user's PRIVATE
 * repositories, which is an unjustified privilege escalation just to let
 * someone pick a repo to analyze. If/when private-repo analysis is wanted,
 * prefer a GitHub App with per-repository installation consent (the user
 * explicitly picks which repos to grant) over broadening this OAuth scope.
 */
export const GITHUB_OAUTH_SCOPES = ['user:email', 'read:user', 'public_repo'];

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
      scope: GITHUB_OAUTH_SCOPES,
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
