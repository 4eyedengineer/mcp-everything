import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';

import { Deployment } from '../database/entities/deployment.entity';
import { McpTestingService } from '../testing/mcp-testing.service';
import { ValidationService } from './validation.service';
import { ValidationController } from './validation.controller';
import { LocalDockerValidatorProvider } from './providers/local-docker-validator.provider';
import { GitHubActionsValidatorProvider } from './providers/github-actions-validator.provider';
import { DeploymentModule } from '../deployment/deployment.module';

/**
 * Module for MCP server validation
 * Provides post-deployment testing capabilities
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Deployment]),
    ConfigModule,
    // Use forwardRef to handle circular dependency with DeploymentModule
    forwardRef(() => DeploymentModule),
  ],
  controllers: [ValidationController],
  providers: [
    ValidationService,
    LocalDockerValidatorProvider,
    GitHubActionsValidatorProvider,
    McpTestingService,
  ],
  exports: [ValidationService],
})
export class ValidationModule {}
