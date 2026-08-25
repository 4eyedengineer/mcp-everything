import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { UserService } from '../user/user.service';
import { EmailService } from '../email/email.service';
import { TokenEncryptionService } from '../common/token-encryption/token-encryption.service';
import { User } from '../database/entities/user.entity';

function buildUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    email: 'octocat@example.com',
    tier: 'free',
    isActive: true,
    isEmailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as User;
}

describe('AuthService - GitHub OAuth token persistence', () => {
  let authService: AuthService;
  let userService: {
    findByGithubId: jest.Mock;
    findByGoogleId: jest.Mock;
    findByEmail: jest.Mock;
    createUser: jest.Mock;
    linkOAuthAccount: jest.Mock;
    updateLastLogin: jest.Mock;
    setGithubToken: jest.Mock;
  };
  let tokenEncryptionService: { encrypt: jest.Mock };

  beforeEach(async () => {
    userService = {
      findByGithubId: jest.fn().mockResolvedValue(null),
      findByGoogleId: jest.fn().mockResolvedValue(null),
      findByEmail: jest.fn().mockResolvedValue(null),
      createUser: jest.fn(),
      linkOAuthAccount: jest.fn().mockResolvedValue(undefined),
      updateLastLogin: jest.fn().mockResolvedValue(undefined),
      setGithubToken: jest.fn().mockResolvedValue(undefined),
    };
    tokenEncryptionService = {
      encrypt: jest.fn((plaintext: string) => `enc(${plaintext})`),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UserService, useValue: userService },
        {
          provide: JwtService,
          useValue: { sign: jest.fn().mockReturnValue('signed.jwt.token') },
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn((_key: string, fallback?: unknown) => fallback) },
        },
        { provide: EmailService, useValue: {} },
        { provide: TokenEncryptionService, useValue: tokenEncryptionService },
      ],
    }).compile();

    authService = module.get(AuthService);
  });

  describe('new user via GitHub OAuth', () => {
    it('encrypts and persists the access token via UserService.setGithubToken', async () => {
      const createdUser = buildUser();
      userService.createUser.mockResolvedValue(createdUser);

      await authService.validateOAuthUser({
        provider: 'github',
        providerId: 'gh-123',
        email: 'octocat@example.com',
        username: 'octocat',
        accessToken: 'gho_plaintexttoken',
      });

      expect(tokenEncryptionService.encrypt).toHaveBeenCalledWith('gho_plaintexttoken');
      expect(userService.setGithubToken).toHaveBeenCalledWith(
        createdUser.id,
        'enc(gho_plaintexttoken)',
        expect.stringContaining('public_repo'),
      );
    });

    it('never persists the unscoped "repo" grant, only the narrower requested scopes', async () => {
      const createdUser = buildUser();
      userService.createUser.mockResolvedValue(createdUser);

      await authService.validateOAuthUser({
        provider: 'github',
        providerId: 'gh-123',
        email: 'octocat@example.com',
        username: 'octocat',
        accessToken: 'gho_plaintexttoken',
      });

      const persistedScope = userService.setGithubToken.mock.calls[0][2] as string;
      expect(persistedScope.split(' ')).not.toContain('repo');
      expect(persistedScope).toContain('public_repo');
    });
  });

  describe('linking GitHub OAuth to an existing (email-matched) user', () => {
    it('persists the access token on the existing user, not a new one', async () => {
      const existingUser = buildUser({ id: 'existing-user-42' });
      userService.findByEmail.mockResolvedValue(existingUser);

      await authService.validateOAuthUser({
        provider: 'github',
        providerId: 'gh-999',
        email: existingUser.email,
        username: 'octocat',
        accessToken: 'gho_linkedtoken',
      });

      expect(userService.linkOAuthAccount).toHaveBeenCalledWith(
        existingUser.id,
        'github',
        'gh-999',
        'octocat',
      );
      expect(userService.setGithubToken).toHaveBeenCalledWith(
        existingUser.id,
        'enc(gho_linkedtoken)',
        expect.any(String),
      );
      expect(userService.createUser).not.toHaveBeenCalled();
    });
  });

  describe('returning user (already linked) via GitHub OAuth', () => {
    it('refreshes the stored token on every subsequent login', async () => {
      const existingUser = buildUser({ id: 'returning-user-7' });
      userService.findByGithubId.mockResolvedValue(existingUser);

      await authService.validateOAuthUser({
        provider: 'github',
        providerId: 'gh-777',
        email: existingUser.email,
        username: 'octocat',
        accessToken: 'gho_firstlogintoken',
      });
      await authService.validateOAuthUser({
        provider: 'github',
        providerId: 'gh-777',
        email: existingUser.email,
        username: 'octocat',
        accessToken: 'gho_secondlogintoken',
      });

      expect(userService.setGithubToken).toHaveBeenCalledTimes(2);
      expect(userService.setGithubToken).toHaveBeenNthCalledWith(
        1,
        existingUser.id,
        'enc(gho_firstlogintoken)',
        expect.any(String),
      );
      expect(userService.setGithubToken).toHaveBeenNthCalledWith(
        2,
        existingUser.id,
        'enc(gho_secondlogintoken)',
        expect.any(String),
      );
    });
  });

  describe('when TOKEN_ENCRYPTION_KEY is not configured', () => {
    it('degrades gracefully: login still succeeds, but no token is persisted', async () => {
      tokenEncryptionService.encrypt.mockReturnValue(undefined);
      const createdUser = buildUser();
      userService.createUser.mockResolvedValue(createdUser);

      const result = await authService.validateOAuthUser({
        provider: 'github',
        providerId: 'gh-123',
        email: 'octocat@example.com',
        username: 'octocat',
        accessToken: 'gho_plaintexttoken',
      });

      expect(result.accessToken).toBe('signed.jwt.token');
      expect(userService.setGithubToken).not.toHaveBeenCalled();
    });
  });

  describe('Google OAuth', () => {
    it('never attempts to persist a GitHub token for Google logins', async () => {
      const createdUser = buildUser({ email: 'googler@example.com' });
      userService.createUser.mockResolvedValue(createdUser);

      await authService.validateOAuthUser({
        provider: 'google',
        providerId: 'google-123',
        email: 'googler@example.com',
        firstName: 'Goo',
        lastName: 'Gler',
      });

      expect(tokenEncryptionService.encrypt).not.toHaveBeenCalled();
      expect(userService.setGithubToken).not.toHaveBeenCalled();
    });
  });

  describe('no access token on the profile', () => {
    it('does not call setGithubToken when GitHub strategy somehow yields no accessToken', async () => {
      const createdUser = buildUser();
      userService.createUser.mockResolvedValue(createdUser);

      await authService.validateOAuthUser({
        provider: 'github',
        providerId: 'gh-123',
        email: 'octocat@example.com',
        username: 'octocat',
      });

      expect(userService.setGithubToken).not.toHaveBeenCalled();
    });
  });
});
