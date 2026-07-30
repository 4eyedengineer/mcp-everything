import { Module } from '@nestjs/common';
import { GitHubController } from './github.controller';
import { GitHubService } from './github.service';

/**
 * Read-only GitHub repo listing/search for the chat page's repo-picker
 * modal. Deliberately separate from GitHubAnalysisService (deep repository
 * analysis for the generation pipeline) - this module only lists/searches
 * repos so the user can pick one, it never fetches file contents.
 */
@Module({
  controllers: [GitHubController],
  providers: [GitHubService],
  exports: [GitHubService],
})
export class GitHubModule {}
