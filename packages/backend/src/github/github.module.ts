import { Module } from '@nestjs/common';
import { GitHubController } from './github.controller';
import { GitHubService } from './github.service';
import { UserModule } from '../user/user.module';
import { TokenEncryptionModule } from '../common/token-encryption/token-encryption.module';

/**
 * Read-only GitHub repo listing/search for the chat page's repo-picker
 * modal, plus per-user connect/disconnect. Deliberately separate from
 * GitHubAnalysisService (deep repository analysis for the generation
 * pipeline) - this module only lists/searches repos so the user can pick
 * one, it never fetches file contents.
 *
 * Imports UserModule (to read/clear a user's stored GitHub token) and
 * TokenEncryptionModule (to decrypt it) - NOT AuthModule, to avoid a
 * module import cycle (AuthModule doesn't need anything from here).
 */
@Module({
  imports: [UserModule, TokenEncryptionModule],
  controllers: [GitHubController],
  providers: [GitHubService],
  exports: [GitHubService],
})
export class GitHubModule {}
