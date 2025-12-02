import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Deployment } from '../database/entities/deployment.entity';
import { Conversation } from '../database/entities/conversation.entity';

import { DeploymentController } from './deployment.controller';
import { DeploymentOrchestratorService } from './deployment.service';

import { GitHubRepoProvider } from './providers/github-repo.provider';
import { GistProvider } from './providers/gist.provider';
import { DevContainerProvider } from './providers/devcontainer.provider';

@Module({
  imports: [TypeOrmModule.forFeature([Deployment, Conversation])],
  controllers: [DeploymentController],
  providers: [
    DeploymentOrchestratorService,
    GitHubRepoProvider,
    GistProvider,
    DevContainerProvider,
  ],
  exports: [DeploymentOrchestratorService],
})
export class DeploymentModule {}
