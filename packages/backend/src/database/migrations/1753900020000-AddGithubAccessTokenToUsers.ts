import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Adds storage for a user's GitHub OAuth access token, so the app can list
 * *that user's own* repositories instead of always reading the single
 * server-wide `GITHUB_TOKEN` PAT regardless of who is logged in.
 *
 * See src/auth/auth.service.ts#validateOAuthUser (persists the token on
 * every GitHub login) and src/github/github.service.ts (builds a per-request
 * Octokit from it). The token is encrypted at rest with AES-256-GCM
 * (src/common/token-encryption/token-encryption.service.ts) using a
 * dedicated `TOKEN_ENCRYPTION_KEY` env var - never the JWT secret - so
 * `githubAccessTokenEncrypted` never holds plaintext.
 *
 * Columns:
 *  - `githubAccessTokenEncrypted`: the encrypted token blob. `select: false`
 *    on the entity (see database/entities/user.entity.ts) so ordinary
 *    `User` loads (e.g. the object attached to every authenticated request
 *    via JwtStrategy/CurrentUser) never carry it - only the explicit
 *    `UserService.findByIdWithGithubToken` opt-in query does.
 *  - `githubTokenScope`: the OAuth scope string granted, for audit/debugging
 *    (e.g. confirming a token predates a scope change).
 *  - `githubTokenUpdatedAt`: when the token was last (re)persisted, so a
 *    stale-but-never-invalidated token is at least inspectable.
 *
 * Guarded with `hasColumn` checks so this is a no-op against a dev database
 * that already has these columns via `synchronize: true` (see the same
 * pattern established by 1753900010000-FixMcpServersSchemaDrift.ts).
 */
export class AddGithubAccessTokenToUsers1753900020000 implements MigrationInterface {
  name = 'AddGithubAccessTokenToUsers1753900020000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasColumn('users', 'githubAccessTokenEncrypted'))) {
      await queryRunner.addColumn(
        'users',
        new TableColumn({
          name: 'githubAccessTokenEncrypted',
          type: 'text',
          isNullable: true,
        }),
      );
    }

    if (!(await queryRunner.hasColumn('users', 'githubTokenScope'))) {
      await queryRunner.addColumn(
        'users',
        new TableColumn({
          name: 'githubTokenScope',
          type: 'varchar',
          length: '255',
          isNullable: true,
        }),
      );
    }

    if (!(await queryRunner.hasColumn('users', 'githubTokenUpdatedAt'))) {
      await queryRunner.addColumn(
        'users',
        new TableColumn({
          name: 'githubTokenUpdatedAt',
          type: 'timestamp',
          isNullable: true,
        }),
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasColumn('users', 'githubTokenUpdatedAt')) {
      await queryRunner.dropColumn('users', 'githubTokenUpdatedAt');
    }
    if (await queryRunner.hasColumn('users', 'githubTokenScope')) {
      await queryRunner.dropColumn('users', 'githubTokenScope');
    }
    if (await queryRunner.hasColumn('users', 'githubAccessTokenEncrypted')) {
      await queryRunner.dropColumn('users', 'githubAccessTokenEncrypted');
    }
  }
}
