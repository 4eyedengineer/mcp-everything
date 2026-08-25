import { Module } from '@nestjs/common';
import { TokenEncryptionService } from './token-encryption.service';

/**
 * Small, dependency-free module wrapping `TokenEncryptionService` so it can
 * be imported by both AuthModule (encrypts a user's GitHub access token
 * before persisting it) and GitHubModule (decrypts it to build a per-user
 * Octokit client) without either module depending on the other.
 */
@Module({
  providers: [TokenEncryptionService],
  exports: [TokenEncryptionService],
})
export class TokenEncryptionModule {}
