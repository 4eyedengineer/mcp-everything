import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';

import { Deployment } from '../database/entities/deployment.entity';
import { TestingModule } from '../testing/testing.module';
import { ValidationService } from './validation.service';
import { ValidationController } from './validation.controller';
import { LocalDockerValidatorProvider } from './providers/local-docker-validator.provider';
import { GitHubActionsValidatorProvider } from './providers/github-actions-validator.provider';
import { McpProtocolValidatorService } from './mcp-protocol-validator.service';
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
    // McpTestingService owns Docker container lifecycle/state (running
    // containers map); it must be a single shared instance, not
    // independently provided per module. See TestingModule.
    TestingModule,
  ],
  controllers: [ValidationController],
  providers: [
    ValidationService,
    LocalDockerValidatorProvider,
    GitHubActionsValidatorProvider,
    McpProtocolValidatorService,
  ],
  exports: [ValidationService, McpProtocolValidatorService],
})
export class ValidationModule {}
