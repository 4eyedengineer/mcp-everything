import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule } from '@nestjs/throttler';

import { Deployment } from '../database/entities/deployment.entity';
import { Conversation } from '../database/entities/conversation.entity';

import { DeploymentController } from './deployment.controller';
import { DeploymentOrchestratorService } from './deployment.service';

import { GitHubRepoProvider } from './providers/github-repo.provider';
import { GistProvider } from './providers/gist.provider';
import { DevContainerProvider } from './providers/devcontainer.provider';
import { GitignoreProvider } from './providers/gitignore.provider';
import { CIWorkflowProvider } from './providers/ci-workflow.provider';
import { ValidationModule } from '../validation/validation.module';
import { UserModule } from '../user/user.module';

import { DeploymentRetryService } from './services/retry.service';
import { DeploymentRollbackService } from './services/rollback.service';
import { DeploymentRouterService } from './services/deployment-router.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Deployment, Conversation]),
    // Rate limiting: 10 deployment requests per minute per IP
    ThrottlerModule.forRoot([{
      ttl: 60000,
      limit: 10,
    }]),
    // Import ValidationModule for post-deployment validation
    forwardRef(() => ValidationModule),
    // Import UserModule for tier-based routing
    forwardRef(() => UserModule),
  ],
  controllers: [DeploymentController],
  providers: [
    DeploymentOrchestratorService,
    GitHubRepoProvider,
    GistProvider,
    DevContainerProvider,
    GitignoreProvider,
    CIWorkflowProvider,
    DeploymentRetryService,
    DeploymentRollbackService,
    DeploymentRouterService,
  ],
  exports: [DeploymentOrchestratorService, DeploymentRetryService, DeploymentRouterService],
})
export class DeploymentModule {}
