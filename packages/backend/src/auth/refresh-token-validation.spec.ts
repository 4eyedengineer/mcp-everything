import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtRefreshStrategy } from './strategies/jwt-refresh.strategy';
import { JwtStrategy } from './strategies/jwt.strategy';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { LocalAuthGuard } from './guards/local-auth.guard';
import { GitHubAuthGuard } from './guards/github-auth.guard';
import { GoogleAuthGuard } from './guards/google-auth.guard';
import { UserService } from '../user/user.service';
import { EmailService } from '../email/email.service';
import { TokenEncryptionService } from '../common/token-encryption/token-encryption.service';
import { User } from '../database/entities/user.entity';

/** Always-allow stub - only the `/auth/refresh` route (guarded by the REAL
 * `JwtRefreshGuard`) is under test here. The other guards referenced by
 * `AuthController`'s other routes (`login`, `logout`, GitHub/Google OAuth)
 * are eagerly instantiated by Nest when the module compiles, so they need
 * to resolve, but exercising them is out of scope for this regression test. */
class AlwaysAllowGuard {
  canActivate() {
    return true;
  }
}

const JWT_SECRET = 'test-access-secret';
const JWT_REFRESH_SECRET = 'test-refresh-secret';

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

/**
 * Regression coverage for the bug where `POST /api/v1/auth/refresh` with a
 * genuinely VALID refresh token returned 400 "property refreshToken should
 * not exist".
 *
 * Root cause: `RefreshTokenDto.refreshToken` had only an `@ApiProperty()`
 * (Swagger) decorator and no class-validator decorator. The app's global
 * `ValidationPipe` runs with `whitelist: true, forbidNonWhitelisted: true`
 * (see `main.ts`), which rejects any property that has zero class-validator
 * metadata as an "unknown" property - even though the DTO class itself
 * declares the field.
 *
 * This must NOT be a plain unit test that instantiates `RefreshTokenDto`
 * directly and skips the pipe - that would trivially pass even with the bug
 * present, since the bug is entirely about how `ValidationPipe` treats the
 * class, not about the class in isolation. Instead this boots a real Nest
 * HTTP server with:
 *   - the SAME global `ValidationPipe` configuration as `main.ts`
 *   - the real `AuthController` route wiring (`@Public()` + `JwtRefreshGuard`)
 *   - the real `JwtRefreshStrategy` (passport-jwt), verifying a genuinely
 *     signed, non-expired refresh token exactly as production does
 *   - the real `AuthService.refreshTokens`
 * and only fakes the data layer (`UserService`) plus notification-only
 * collaborators (`EmailService`, `TokenEncryptionService`) that this route
 * doesn't touch.
 */
describe('POST /api/v1/auth/refresh (ValidationPipe regression)', () => {
  let app: INestApplication;
  let jwtService: JwtService;
  const user = buildUser();

  beforeAll(async () => {
    const userServiceMock = {
      findById: jest.fn().mockResolvedValue(user),
    };

    const configServiceMock = {
      get: jest.fn((key: string, fallback?: unknown) => {
        switch (key) {
          case 'JWT_SECRET':
            return JWT_SECRET;
          case 'JWT_REFRESH_SECRET':
            return JWT_REFRESH_SECRET;
          case 'JWT_EXPIRY':
            return fallback ?? '15m';
          case 'JWT_REFRESH_EXPIRY':
            return fallback ?? '7d';
          default:
            return fallback;
        }
      }),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        PassportModule.register({ defaultStrategy: 'jwt' }),
        JwtModule.register({ secret: JWT_SECRET, signOptions: { expiresIn: '15m' } }),
      ],
      controllers: [AuthController],
      providers: [
        AuthService,
        JwtStrategy,
        JwtRefreshStrategy,
        { provide: UserService, useValue: userServiceMock },
        { provide: ConfigService, useValue: configServiceMock },
        { provide: EmailService, useValue: {} },
        { provide: TokenEncryptionService, useValue: {} },
      ],
    })
      // These guards aren't declared as providers - Nest resolves classes
      // referenced via `@UseGuards()` as their own "injectables" independent
      // of the `providers` array, so a plain `{ provide: X, useValue }` entry
      // does NOT override them here; `overrideGuard()` is the API meant for
      // exactly this. Only `/auth/refresh`'s REAL `JwtRefreshGuard` matters
      // for this regression test - these are stubbed purely so the module
      // can compile (their own constructor deps, e.g. ApiKeyService, are
      // irrelevant to the bug under test).
      .overrideGuard(JwtAuthGuard)
      .useValue(new AlwaysAllowGuard())
      .overrideGuard(LocalAuthGuard)
      .useValue(new AlwaysAllowGuard())
      .overrideGuard(GitHubAuthGuard)
      .useValue(new AlwaysAllowGuard())
      .overrideGuard(GoogleAuthGuard)
      .useValue(new AlwaysAllowGuard())
      .compile();

    app = moduleFixture.createNestApplication();

    // MUST mirror main.ts exactly - this is the configuration that produced
    // the bug (whitelist + forbidNonWhitelisted stripping/rejecting any
    // property without a class-validator decorator).
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );

    await app.init();

    jwtService = moduleFixture.get(JwtService);
  });

  afterAll(async () => {
    await app.close();
  });

  function signRefreshToken(overrides: Partial<{ sub: string; email: string; tier: string }> = {}) {
    return jwtService.sign(
      { sub: user.id, email: user.email, tier: user.tier, ...overrides },
      { secret: JWT_REFRESH_SECRET, expiresIn: '7d' },
    );
  }

  it('returns 200 with fresh tokens for a genuinely valid refresh token', async () => {
    const refreshToken = signRefreshToken();

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken })
      .expect(200);

    expect(response.body).toMatchObject({
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
      expiresIn: expect.any(Number),
      user: expect.objectContaining({ id: user.id, email: user.email }),
    });
    // A fresh access token must actually be issued, not just an echo.
    expect(typeof response.body.accessToken).toBe('string');
    expect(response.body.accessToken.length).toBeGreaterThan(0);
  });

  it('returns 401 (not 400) for a well-formed but invalid/expired refresh token', async () => {
    const expiredToken = jwtService.sign(
      { sub: user.id, email: user.email, tier: user.tier },
      { secret: JWT_REFRESH_SECRET, expiresIn: -10 },
    );

    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: expiredToken })
      .expect(401);
  });

  it('still rejects a request with a genuinely missing refreshToken field', async () => {
    await request(app.getHttpServer()).post('/api/v1/auth/refresh').send({}).expect(401);
  });
});
