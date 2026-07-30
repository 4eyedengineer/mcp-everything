import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateApiKeysTable1753800000000 implements MigrationInterface {
  name = 'CreateApiKeysTable1753800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE api_keys (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "userId" UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(100) NOT NULL,
        "keyPrefix" VARCHAR(16) NOT NULL,
        "keyHash" VARCHAR(64) NOT NULL UNIQUE,
        "lastUsedAt" TIMESTAMP,
        "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
        "revokedAt" TIMESTAMP
      );

      CREATE INDEX "IDX_api_keys_userId" ON api_keys("userId");
      CREATE INDEX "IDX_api_keys_keyHash" ON api_keys("keyHash");
      CREATE INDEX "IDX_api_keys_revokedAt" ON api_keys("revokedAt");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS api_keys');
  }
}
