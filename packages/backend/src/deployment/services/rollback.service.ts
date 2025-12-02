import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Deployment } from '../../database/entities/deployment.entity';
import { GitHubRepoProvider } from '../providers/github-repo.provider';
import { GistProvider } from '../providers/gist.provider';

/**
 * Result of a rollback operation
 */
export interface RollbackResult {
  success: boolean;
  resourcesDeleted: string[];
  errors: string[];
}

@Injectable()
export class DeploymentRollbackService {
  private readonly logger = new Logger(DeploymentRollbackService.name);

  constructor(
    @InjectRepository(Deployment)
    private readonly deploymentRepository: Repository<Deployment>,
    private readonly gitHubRepoProvider: GitHubRepoProvider,
    private readonly gistProvider: GistProvider,
  ) {}

  /**
   * Rollback a failed deployment by cleaning up created resources
   */
  async rollback(deploymentId: string, reason: string): Promise<RollbackResult> {
    const result: RollbackResult = {
      success: true,
      resourcesDeleted: [],
      errors: [],
    };

    const deployment = await this.deploymentRepository.findOneBy({
      id: deploymentId,
    });
    if (!deployment) {
      result.success = false;
      result.errors.push('Deployment not found');
      return result;
    }

    this.logger.log(
      `Starting rollback for deployment ${deploymentId}: ${reason}`,
    );

    try {
      if (deployment.deploymentType === 'repo' && deployment.repositoryUrl) {
        await this.rollbackRepository(deployment, result);
      } else if (deployment.deploymentType === 'gist') {
        await this.rollbackGist(deployment, result);
      }

      // Update deployment metadata with rollback info
      const updatedMetadata = {
        ...(deployment.metadata || {}),
        rollbackPerformed: true,
        rollbackReason: reason,
        rollbackTimestamp: new Date().toISOString(),
      };

      await this.deploymentRepository.update(deploymentId, {
        metadata: updatedMetadata as Record<string, any>,
      });
    } catch (error) {
      result.success = false;
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      result.errors.push(`Rollback error: ${errorMessage}`);
      this.logger.error(`Rollback failed for ${deploymentId}: ${errorMessage}`);
    }

    return result;
  }

  /**
   * Rollback a repository deployment by deleting the repository
   */
  private async rollbackRepository(
    deployment: Deployment,
    result: RollbackResult,
  ): Promise<void> {
    const parsed = this.gitHubRepoProvider.parseRepoUrl(
      deployment.repositoryUrl!,
    );
    if (!parsed) {
      result.errors.push(
        `Could not parse repository URL: ${deployment.repositoryUrl}`,
      );
      return;
    }

    try {
      const deleted = await this.gitHubRepoProvider.deleteRepository(
        parsed.owner,
        parsed.repo,
      );
      if (deleted) {
        result.resourcesDeleted.push(
          `Repository: ${parsed.owner}/${parsed.repo}`,
        );
        this.logger.log(
          `Rolled back repository: ${parsed.owner}/${parsed.repo}`,
        );
      } else {
        result.errors.push(
          `Failed to delete repository: ${parsed.owner}/${parsed.repo}`,
        );
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      result.errors.push(`Repository deletion error: ${errorMessage}`);
    }
  }

  /**
   * Rollback a gist deployment by deleting the gist
   */
  private async rollbackGist(
    deployment: Deployment,
    result: RollbackResult,
  ): Promise<void> {
    const gistId = deployment.metadata?.gistId as string | undefined;
    if (!gistId) {
      this.logger.debug('No gist ID found, nothing to rollback');
      return;
    }

    try {
      const deleted = await this.gistProvider.deleteGist(gistId);
      if (deleted) {
        result.resourcesDeleted.push(`Gist: ${gistId}`);
        this.logger.log(`Rolled back gist: ${gistId}`);
      } else {
        result.errors.push(`Failed to delete gist: ${gistId}`);
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      result.errors.push(`Gist deletion error: ${errorMessage}`);
    }
  }

  /**
   * Check if a deployment can be rolled back
   */
  canRollback(deployment: Deployment): boolean {
    if (deployment.status !== 'failed') {
      return false;
    }

    // Check if rollback was already performed
    if (deployment.metadata?.rollbackPerformed) {
      return false;
    }

    // Check if there are resources to roll back
    if (deployment.deploymentType === 'repo' && deployment.repositoryUrl) {
      return true;
    }

    if (deployment.deploymentType === 'gist' && deployment.metadata?.gistId) {
      return true;
    }

    return false;
  }
}
