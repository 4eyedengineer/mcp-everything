import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Deployment } from '../database/entities/deployment.entity';
import { LocalDockerValidatorProvider } from './providers/local-docker-validator.provider';
import { GitHubActionsValidatorProvider } from './providers/github-actions-validator.provider';
import {
  ValidationResult,
  ValidationOptions,
  ValidationResponse,
  ValidationStatusResponse,
  ValidationProgressUpdate,
  ValidationStatus,
} from './types/validation.types';

/**
 * Service for validating deployed MCP servers
 * Orchestrates local Docker and GitHub Actions validation
 */
@Injectable()
export class ValidationService {
  private readonly logger = new Logger(ValidationService.name);
  private progressCallbacks: Map<string, (update: ValidationProgressUpdate) => void> = new Map();

  constructor(
    @InjectRepository(Deployment)
    private readonly deploymentRepository: Repository<Deployment>,
    private readonly localDockerValidator: LocalDockerValidatorProvider,
    private readonly githubActionsValidator: GitHubActionsValidatorProvider,
  ) {}

  /**
   * Register progress callback for streaming updates
   */
  registerProgressCallback(
    deploymentId: string,
    callback: (update: ValidationProgressUpdate) => void,
  ): void {
    this.progressCallbacks.set(deploymentId, callback);
    // Also register with local docker validator
    this.localDockerValidator.registerProgressCallback(deploymentId, callback);
  }

  /**
   * Unregister progress callback
   */
  unregisterProgressCallback(deploymentId: string): void {
    this.progressCallbacks.delete(deploymentId);
    this.localDockerValidator.unregisterProgressCallback(deploymentId);
  }

  /**
   * Validate a deployment
   */
  async validateDeployment(
    deploymentId: string,
    options: ValidationOptions = {},
  ): Promise<ValidationResponse> {
    const deployment = await this.deploymentRepository.findOneBy({ id: deploymentId });
    if (!deployment) {
      throw new NotFoundException(`Deployment not found: ${deploymentId}`);
    }

    // Check if already validated and not forcing revalidation
    if (
      deployment.validationStatus === 'passed' &&
      !options.forceRevalidate
    ) {
      return {
        success: true,
        deploymentId,
        validationStatus: 'passed',
        message: 'Deployment already validated',
        result: deployment.validationResults as ValidationResult,
        validatedAt: deployment.validatedAt,
        toolsPassedCount: deployment.toolsPassedCount,
        toolsTestedCount: deployment.toolsTestedCount,
      };
    }

    // Update status to running
    await this.deploymentRepository.update(deploymentId, {
      validationStatus: 'running',
    });

    this.streamProgress(deploymentId, {
      type: 'starting',
      message: 'Starting validation...',
      timestamp: new Date(),
    });

    try {
      let result: ValidationResult;

      // Choose validation method based on deployment type
      if (deployment.deploymentType === 'repo' && deployment.repositoryUrl) {
        // For GitHub repos, we can use local Docker (primary) or GitHub Actions (secondary)
        result = await this.localDockerValidator.validateFromFileSystem(
          deployment.conversationId,
          options,
        );

        // If local validation passed and we have a repo, also check GitHub Actions
        if (result.buildSuccess && deployment.repositoryUrl) {
          try {
            const ghResult = await this.githubActionsValidator.validateRepository(
              deployment.repositoryUrl,
            );
            // If GitHub Actions failed but local passed, add a warning
            if (!ghResult.buildSuccess) {
              result.errors = result.errors || [];
              result.errors.push(`GitHub Actions validation failed: ${ghResult.errors?.join(', ')}`);
            }
          } catch (error) {
            this.logger.warn(`GitHub Actions validation failed: ${error.message}`);
          }
        }
      } else if (deployment.deploymentType === 'gist') {
        // For Gists, use local Docker validation only
        result = await this.localDockerValidator.validateFromFileSystem(
          deployment.conversationId,
          options,
        );
      } else {
        // No deployment to validate
        result = {
          buildSuccess: false,
          buildError: 'No deployment found to validate',
          toolResults: [],
          errors: ['Deployment type not supported for validation'],
          source: 'local_docker',
        };
      }

      // Calculate metrics
      const toolsTestedCount = result.toolResults.length;
      const toolsPassedCount = result.toolResults.filter((r) => r.success).length;
      const validationStatus: ValidationStatus = result.buildSuccess && toolsPassedCount === toolsTestedCount
        ? 'passed'
        : 'failed';

      // Update deployment record
      await this.deploymentRepository.update(deploymentId, {
        validationStatus,
        validatedAt: new Date(),
        toolsPassedCount,
        toolsTestedCount,
        validationResults: result as any,
      });

      this.streamProgress(deploymentId, {
        type: 'complete',
        message: `Validation ${validationStatus}: ${toolsPassedCount}/${toolsTestedCount} tools passed`,
        timestamp: new Date(),
      });

      return {
        success: validationStatus === 'passed',
        deploymentId,
        validationStatus,
        message: `Validation ${validationStatus}: ${toolsPassedCount}/${toolsTestedCount} tools passed`,
        result,
        validatedAt: new Date(),
        toolsPassedCount,
        toolsTestedCount,
      };
    } catch (error) {
      this.logger.error(`Validation failed for deployment ${deploymentId}: ${error.message}`);

      // Update deployment record with failure
      await this.deploymentRepository.update(deploymentId, {
        validationStatus: 'failed',
        validatedAt: new Date(),
        validationResults: {
          buildSuccess: false,
          buildError: error.message,
          toolResults: [],
          errors: [error.message],
          source: 'local_docker',
        } as any,
      });

      this.streamProgress(deploymentId, {
        type: 'error',
        message: `Validation failed: ${error.message}`,
        timestamp: new Date(),
      });

      return {
        success: false,
        deploymentId,
        validationStatus: 'failed',
        message: `Validation failed: ${error.message}`,
      };
    }
  }

  /**
   * Get validation status for a deployment
   */
  async getValidationStatus(deploymentId: string): Promise<ValidationStatusResponse> {
    const deployment = await this.deploymentRepository.findOneBy({ id: deploymentId });
    if (!deployment) {
      throw new NotFoundException(`Deployment not found: ${deploymentId}`);
    }

    return {
      deploymentId,
      validationStatus: deployment.validationStatus,
      validatedAt: deployment.validatedAt,
      toolsPassedCount: deployment.toolsPassedCount,
      toolsTestedCount: deployment.toolsTestedCount,
      validationResults: deployment.validationResults as ValidationResult,
      workflowRunId: deployment.workflowRunId,
    };
  }

  /**
   * Poll GitHub Actions for validation results
   */
  async pollGitHubActionsValidation(deploymentId: string): Promise<ValidationResponse> {
    const deployment = await this.deploymentRepository.findOneBy({ id: deploymentId });
    if (!deployment) {
      throw new NotFoundException(`Deployment not found: ${deploymentId}`);
    }

    if (deployment.deploymentType !== 'repo' || !deployment.repositoryUrl) {
      return {
        success: false,
        deploymentId,
        validationStatus: 'skipped',
        message: 'GitHub Actions validation only available for repository deployments',
      };
    }

    try {
      const result = await this.githubActionsValidator.validateRepository(
        deployment.repositoryUrl,
      );

      const toolsTestedCount = result.toolResults.length;
      const toolsPassedCount = result.toolResults.filter((r) => r.success).length;
      const validationStatus: ValidationStatus = result.buildSuccess ? 'passed' : 'failed';

      // Update deployment record with GitHub Actions results
      await this.deploymentRepository.update(deploymentId, {
        validationStatus,
        validatedAt: new Date(),
        toolsPassedCount,
        toolsTestedCount,
        validationResults: result as any,
      });

      return {
        success: result.buildSuccess,
        deploymentId,
        validationStatus,
        message: `GitHub Actions validation ${validationStatus}`,
        result,
        validatedAt: new Date(),
        toolsPassedCount,
        toolsTestedCount,
      };
    } catch (error) {
      this.logger.error(`GitHub Actions polling failed: ${error.message}`);
      return {
        success: false,
        deploymentId,
        validationStatus: 'failed',
        message: `GitHub Actions polling failed: ${error.message}`,
      };
    }
  }

  /**
   * Stream progress update
   */
  private streamProgress(deploymentId: string, update: ValidationProgressUpdate): void {
    const callback = this.progressCallbacks.get(deploymentId);
    if (callback) {
      callback(update);
    }
  }
}
