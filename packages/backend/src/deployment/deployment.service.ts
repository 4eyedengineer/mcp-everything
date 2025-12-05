import { Injectable, Logger, NotFoundException, NotImplementedException, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

import { Deployment } from '../database/entities/deployment.entity';
import { Conversation } from '../database/entities/conversation.entity';
import { GitHubRepoProvider } from './providers/github-repo.provider';
import { GistProvider, McpToolInfo } from './providers/gist.provider';
import { DevContainerProvider } from './providers/devcontainer.provider';
import { GitignoreProvider } from './providers/gitignore.provider';
import { CIWorkflowProvider } from './providers/ci-workflow.provider';
import { DeploymentRetryService } from './services/retry.service';
import { DeploymentRollbackService } from './services/rollback.service';
import { ValidationService } from '../validation/validation.service';
import {
  DeploymentResult,
  DeploymentStatusResponse,
  DeploymentFile,
  DeploymentOptions,
  DeploymentFilters,
  PaginatedDeployments,
  DeleteDeploymentResult,
  DeploymentType,
  DeploymentStatus,
  EnterpriseDeploymentOptions,
} from './types/deployment.types';
import {
  DeploymentErrorCode,
  ERROR_RETRY_CONFIG,
  ERROR_USER_MESSAGES,
  RetryStrategy,
} from './types/deployment-errors.types';

@Injectable()
export class DeploymentOrchestratorService {
  private readonly logger = new Logger(DeploymentOrchestratorService.name);
  private readonly generatedServersDir: string;

  constructor(
    @InjectRepository(Deployment)
    private readonly deploymentRepository: Repository<Deployment>,
    @InjectRepository(Conversation)
    private readonly conversationRepository: Repository<Conversation>,
    private readonly gitHubRepoProvider: GitHubRepoProvider,
    private readonly gistProvider: GistProvider,
    private readonly devContainerProvider: DevContainerProvider,
    private readonly gitignoreProvider: GitignoreProvider,
    private readonly ciWorkflowProvider: CIWorkflowProvider,
    private readonly retryService: DeploymentRetryService,
    private readonly rollbackService: DeploymentRollbackService,
    @Inject(forwardRef(() => ValidationService))
    private readonly validationService: ValidationService,
  ) {
    this.generatedServersDir = join(process.cwd(), '../../generated-servers');
  }

  /**
   * Trigger validation asynchronously after deployment
   * Does not block the deployment response
   */
  private async triggerValidationAsync(deploymentId: string): Promise<void> {
    // Run validation in the background
    setImmediate(async () => {
      try {
        this.logger.log(`Starting post-deployment validation for: ${deploymentId}`);
        await this.validationService.validateDeployment(deploymentId);
        this.logger.log(`Post-deployment validation completed for: ${deploymentId}`);
      } catch (error) {
        this.logger.error(`Post-deployment validation failed for ${deploymentId}: ${error.message}`);
      }
    });
  }

  /**
   * Deploy to a GitHub repository
   */
  async deployToGitHub(
    conversationId: string,
    options: DeploymentOptions = {},
  ): Promise<DeploymentResult> {
    this.logger.log(`Starting GitHub deployment for conversation: ${conversationId}`);

    // Validate conversation exists
    const conversation = await this.conversationRepository.findOneBy({
      id: conversationId,
    });

    if (!conversation) {
      throw new NotFoundException(`Conversation not found: ${conversationId}`);
    }

    // Create pending deployment record
    const deployment = this.deploymentRepository.create({
      conversationId,
      deploymentType: 'repo',
      status: 'pending',
      metadata: { options },
    });
    const savedDeployment = await this.deploymentRepository.save(deployment);

    try {
      // Get generated files
      const files = await this.getGeneratedFiles(conversationId);

      if (files.length === 0) {
        // Update deployment record with failure - no files to deploy
        await this.deploymentRepository.update(savedDeployment.id, {
          status: 'failed',
          errorMessage: ERROR_USER_MESSAGES[DeploymentErrorCode.NO_FILES_TO_DEPLOY],
          deployedAt: new Date(),
          metadata: {
            ...(savedDeployment.metadata || {}),
            errorCode: DeploymentErrorCode.NO_FILES_TO_DEPLOY,
            retryStrategy: ERROR_RETRY_CONFIG[DeploymentErrorCode.NO_FILES_TO_DEPLOY].strategy,
          } as Record<string, any>,
        });

        return {
          success: false,
          deploymentId: savedDeployment.id,
          type: 'repo',
          urls: {},
          error: ERROR_USER_MESSAGES[DeploymentErrorCode.NO_FILES_TO_DEPLOY],
          errorCode: DeploymentErrorCode.NO_FILES_TO_DEPLOY,
          retryStrategy: ERROR_RETRY_CONFIG[DeploymentErrorCode.NO_FILES_TO_DEPLOY].strategy,
        };
      }

      const serverName = options.serverName || this.getServerName(conversation);

      // Always add .gitignore
      files.push(...this.gitignoreProvider.generateGitignoreFiles());

      // Always add CI workflow for GitHub repos
      files.push(...this.ciWorkflowProvider.generateCIWorkflowFiles(serverName));

      // Always add devcontainer for GitHub repos (enables Codespace testing)
      const devContainerFiles = this.devContainerProvider.generateDevContainerFiles(
        serverName,
        'typescript',
      );
      files.push(...devContainerFiles);

      // Deploy to GitHub (default to private repos)
      const result = await this.gitHubRepoProvider.deploy(
        serverName,
        files,
        options.description || `MCP Server generated from conversation ${conversationId}`,
        options.isPrivate ?? true,
        options.envVars, // Pass environment variables for secret creation
      );

      if (result.success) {
        // Update deployment record with success
        await this.deploymentRepository.update(savedDeployment.id, {
          status: 'success',
          repositoryUrl: result.repositoryUrl,
          codespaceUrl: result.codespaceUrl,
          deployedAt: new Date(),
        });

        // Trigger validation asynchronously (non-blocking)
        this.triggerValidationAsync(savedDeployment.id);

        return {
          success: true,
          deploymentId: savedDeployment.id,
          type: 'repo',
          urls: {
            repository: result.repositoryUrl,
            clone: result.cloneUrl,
            codespace: result.codespaceUrl,
          },
        };
      } else {
        throw new Error(result.error || 'GitHub deployment failed');
      }
    } catch (error) {
      const err = error as Error;
      const deploymentError = this.retryService.parseGitHubError(error);

      // Generate suggested names for naming conflicts
      const suggestedNames =
        deploymentError.code === DeploymentErrorCode.REPOSITORY_NAME_CONFLICT
          ? this.retryService.generateAlternativeNames(
              options.serverName || 'mcp-server',
            )
          : undefined;

      // Update deployment record with failure and error details
      const updatedMetadata = {
        ...(savedDeployment.metadata || {}),
        errorCode: deploymentError.code,
        retryStrategy: deploymentError.retryStrategy,
        suggestedNames,
      };
      await this.deploymentRepository.update(savedDeployment.id, {
        status: 'failed',
        errorMessage: deploymentError.userMessage,
        deployedAt: new Date(),
        metadata: updatedMetadata as Record<string, any>,
      });

      return {
        success: false,
        deploymentId: savedDeployment.id,
        type: 'repo',
        urls: {},
        error: deploymentError.userMessage,
        errorCode: deploymentError.code,
        retryStrategy: deploymentError.retryStrategy,
        retryAfterMs: deploymentError.retryAfterMs,
        suggestedNames,
      };
    }
  }

  /**
   * Deploy to a GitHub Gist (single-file bundled format for free tier)
   */
  async deployToGist(
    conversationId: string,
    options: DeploymentOptions = {},
  ): Promise<DeploymentResult> {
    this.logger.log(`Starting Gist deployment for conversation: ${conversationId}`);

    // Validate conversation exists
    const conversation = await this.conversationRepository.findOneBy({
      id: conversationId,
    });

    if (!conversation) {
      throw new NotFoundException(`Conversation not found: ${conversationId}`);
    }

    // Create pending deployment record
    const deployment = this.deploymentRepository.create({
      conversationId,
      deploymentType: 'gist',
      status: 'pending',
      metadata: { options },
    });
    const savedDeployment = await this.deploymentRepository.save(deployment);

    try {
      // Get generated files
      const files = await this.getGeneratedFiles(conversationId);

      if (files.length === 0) {
        // Update deployment record with failure - no files to deploy
        await this.deploymentRepository.update(savedDeployment.id, {
          status: 'failed',
          errorMessage: ERROR_USER_MESSAGES[DeploymentErrorCode.NO_FILES_TO_DEPLOY],
          deployedAt: new Date(),
          metadata: {
            ...(savedDeployment.metadata || {}),
            errorCode: DeploymentErrorCode.NO_FILES_TO_DEPLOY,
            retryStrategy: ERROR_RETRY_CONFIG[DeploymentErrorCode.NO_FILES_TO_DEPLOY].strategy,
          } as Record<string, any>,
        });

        return {
          success: false,
          deploymentId: savedDeployment.id,
          type: 'gist',
          urls: {},
          error: ERROR_USER_MESSAGES[DeploymentErrorCode.NO_FILES_TO_DEPLOY],
          errorCode: DeploymentErrorCode.NO_FILES_TO_DEPLOY,
          retryStrategy: ERROR_RETRY_CONFIG[DeploymentErrorCode.NO_FILES_TO_DEPLOY].strategy,
        };
      }

      // Extract tools from conversation state
      const tools = this.getToolsFromConversation(conversation);

      const serverName = options.serverName || this.getServerName(conversation);

      // Deploy to Gist using single-file bundled format
      const result = await this.gistProvider.deploySingleFile(
        serverName,
        files,
        options.description || `MCP Server generated from conversation ${conversationId}`,
        tools,
        !options.isPrivate, // Gist uses isPublic, not isPrivate
      );

      if (result.success) {
        // Update deployment record with success
        const updatedMetadata = {
          ...(savedDeployment.metadata || {}),
          gistId: result.gistId,
          rawUrl: result.rawUrl,
        };
        await this.deploymentRepository.update(savedDeployment.id, {
          status: 'success',
          gistUrl: result.gistUrl,
          deployedAt: new Date(),
          metadata: updatedMetadata as Record<string, any>,
        });

        // Trigger validation asynchronously (non-blocking)
        this.triggerValidationAsync(savedDeployment.id);

        return {
          success: true,
          deploymentId: savedDeployment.id,
          type: 'gist',
          urls: {
            gist: result.gistUrl,
            gistRaw: result.rawUrl,
          },
        };
      } else {
        throw new Error(result.error || 'Gist deployment failed');
      }
    } catch (error) {
      const err = error as Error;
      const deploymentError = this.retryService.parseGitHubError(error);

      // Update deployment record with failure and error details
      const updatedMetadata = {
        ...(savedDeployment.metadata || {}),
        errorCode: deploymentError.code,
        retryStrategy: deploymentError.retryStrategy,
      };
      await this.deploymentRepository.update(savedDeployment.id, {
        status: 'failed',
        errorMessage: deploymentError.userMessage,
        deployedAt: new Date(),
        metadata: updatedMetadata as Record<string, any>,
      });

      return {
        success: false,
        deploymentId: savedDeployment.id,
        type: 'gist',
        urls: {},
        error: deploymentError.userMessage,
        errorCode: deploymentError.code,
        retryStrategy: deploymentError.retryStrategy,
        retryAfterMs: deploymentError.retryAfterMs,
      };
    }
  }

  /**
   * Get deployment status for a conversation
   */
  async getDeploymentStatus(conversationId: string): Promise<DeploymentStatusResponse[]> {
    const deployments = await this.deploymentRepository.find({
      where: { conversationId },
      order: { createdAt: 'DESC' },
    });

    return deployments.map((d) => ({
      deploymentId: d.id,
      conversationId: d.conversationId,
      type: d.deploymentType,
      status: d.status,
      urls: {
        repository: d.repositoryUrl,
        gist: d.gistUrl,
        gistRaw: d.metadata?.rawUrl as string | undefined,
        codespace: d.codespaceUrl,
      },
      errorMessage: d.errorMessage,
      createdAt: d.createdAt,
      deployedAt: d.deployedAt,
    }));
  }

  /**
   * Retry a failed deployment
   * @param deploymentId The ID of the failed deployment to retry
   * @param newServerName Optional new server name (useful for naming conflicts)
   * @param forceRetry Force retry even if the error type suggests not to
   */
  async retryDeployment(
    deploymentId: string,
    newServerName?: string,
    forceRetry?: boolean,
  ): Promise<DeploymentResult> {
    const deployment = await this.deploymentRepository.findOneBy({ id: deploymentId });

    if (!deployment) {
      throw new NotFoundException(`Deployment not found: ${deploymentId}`);
    }

    if (deployment.status !== 'failed') {
      throw new Error('Can only retry failed deployments');
    }

    // Check if retry is allowed based on error type
    const errorCode = deployment.metadata?.errorCode as DeploymentErrorCode | undefined;
    if (errorCode && !forceRetry) {
      const config = ERROR_RETRY_CONFIG[errorCode];
      if (config.strategy === RetryStrategy.NONE) {
        return {
          success: false,
          deploymentId,
          type: deployment.deploymentType as 'repo' | 'gist',
          urls: {},
          error: `Cannot retry this error type (${errorCode}). Use forceRetry to override.`,
          errorCode,
          retryStrategy: config.strategy,
        };
      }
    }

    // Build options, potentially with new server name
    const originalOptions = (deployment.metadata?.options as DeploymentOptions) || {};
    const options: DeploymentOptions = {
      ...originalOptions,
      ...(newServerName ? { serverName: newServerName } : {}),
    };

    // Track retry attempt in metadata
    const retryCount = ((deployment.metadata?.retryCount as number) || 0) + 1;
    const retryMetadata = {
      ...(deployment.metadata || {}),
      retryCount,
      lastRetryAt: new Date().toISOString(),
    };
    await this.deploymentRepository.update(deploymentId, {
      metadata: retryMetadata as Record<string, any>,
    });

    if (deployment.deploymentType === 'repo') {
      return this.deployToGitHub(deployment.conversationId, options);
    } else if (deployment.deploymentType === 'gist') {
      return this.deployToGist(deployment.conversationId, options);
    } else {
      throw new Error(`Unknown deployment type: ${deployment.deploymentType}`);
    }
  }

  /**
   * Get the latest deployment for a conversation
   */
  async getLatestDeployment(conversationId: string): Promise<Deployment | null> {
    return this.deploymentRepository.findOne({
      where: { conversationId },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Get a single deployment by ID
   */
  async getDeploymentById(deploymentId: string): Promise<DeploymentStatusResponse | null> {
    const deployment = await this.deploymentRepository.findOneBy({ id: deploymentId });

    if (!deployment) {
      return null;
    }

    return {
      deploymentId: deployment.id,
      conversationId: deployment.conversationId,
      type: deployment.deploymentType,
      status: deployment.status,
      urls: {
        repository: deployment.repositoryUrl,
        gist: deployment.gistUrl,
        gistRaw: deployment.metadata?.rawUrl as string | undefined,
        codespace: deployment.codespaceUrl,
      },
      errorMessage: deployment.errorMessage,
      createdAt: deployment.createdAt,
      deployedAt: deployment.deployedAt,
    };
  }

  /**
   * List all deployments with filtering and pagination
   */
  async listDeployments(filters: DeploymentFilters = {}): Promise<PaginatedDeployments> {
    const { type, status, limit = 20, offset = 0 } = filters;

    // Build query conditions
    const where: Record<string, unknown> = {};
    if (type) {
      where.deploymentType = type;
    }
    if (status) {
      where.status = status;
    }

    // Get total count
    const total = await this.deploymentRepository.count({ where });

    // Get paginated results
    const deployments = await this.deploymentRepository.find({
      where,
      order: { createdAt: 'DESC' },
      take: Math.min(limit, 100), // Cap at 100
      skip: offset,
    });

    return {
      deployments: deployments.map((d) => ({
        deploymentId: d.id,
        conversationId: d.conversationId,
        type: d.deploymentType,
        status: d.status,
        urls: {
          repository: d.repositoryUrl,
          gist: d.gistUrl,
          gistRaw: d.metadata?.rawUrl as string | undefined,
          codespace: d.codespaceUrl,
        },
        errorMessage: d.errorMessage,
        createdAt: d.createdAt,
        deployedAt: d.deployedAt,
      })),
      total,
      limit: Math.min(limit, 100),
      offset,
    };
  }

  /**
   * Update a Gist deployment (description only)
   */
  async updateGistDeployment(
    deploymentId: string,
    description?: string,
  ): Promise<DeploymentResult> {
    const deployment = await this.deploymentRepository.findOneBy({ id: deploymentId });

    if (!deployment) {
      throw new NotFoundException(`Deployment not found: ${deploymentId}`);
    }

    if (deployment.deploymentType !== 'gist') {
      throw new Error('Can only update Gist deployments');
    }

    const gistId = deployment.metadata?.gistId as string | undefined;
    if (!gistId) {
      throw new Error('Gist ID not found in deployment metadata');
    }

    try {
      // Get the conversation to re-read files if needed
      const conversation = await this.conversationRepository.findOneBy({
        id: deployment.conversationId,
      });

      if (!conversation) {
        throw new Error('Conversation not found');
      }

      // Re-read files and update gist
      const files = await this.getGeneratedFiles(deployment.conversationId);
      const result = await this.gistProvider.updateGist(gistId, files, description);

      if (result.success) {
        // Update deployment metadata
        const updatedMetadata = {
          ...(deployment.metadata || {}),
          rawUrl: result.rawUrl,
        };
        await this.deploymentRepository.update(deploymentId, {
          metadata: updatedMetadata as Record<string, any>,
        });

        return {
          success: true,
          deploymentId,
          type: 'gist',
          urls: {
            gist: result.gistUrl,
            gistRaw: result.rawUrl,
          },
        };
      } else {
        throw new Error(result.error || 'Failed to update Gist');
      }
    } catch (error) {
      this.logger.error(`Failed to update Gist deployment: ${error.message}`);
      return {
        success: false,
        deploymentId,
        type: 'gist',
        urls: {},
        error: error.message,
      };
    }
  }

  /**
   * Delete a Gist deployment
   */
  async deleteGistDeployment(deploymentId: string): Promise<DeleteDeploymentResult> {
    const deployment = await this.deploymentRepository.findOneBy({ id: deploymentId });

    if (!deployment) {
      throw new NotFoundException(`Deployment not found: ${deploymentId}`);
    }

    if (deployment.deploymentType !== 'gist') {
      throw new Error('Can only delete Gist deployments with this method');
    }

    const gistId = deployment.metadata?.gistId as string | undefined;
    if (!gistId) {
      // No gist to delete, just remove the record
      await this.deploymentRepository.delete(deploymentId);
      return { success: true };
    }

    try {
      const deleted = await this.gistProvider.deleteGist(gistId);
      if (deleted) {
        await this.deploymentRepository.delete(deploymentId);
        return { success: true };
      } else {
        return { success: false, error: 'Failed to delete Gist from GitHub' };
      }
    } catch (error) {
      this.logger.error(`Failed to delete Gist deployment: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Delete a repository deployment
   */
  async deleteRepoDeployment(deploymentId: string): Promise<DeleteDeploymentResult> {
    const deployment = await this.deploymentRepository.findOneBy({ id: deploymentId });

    if (!deployment) {
      throw new NotFoundException(`Deployment not found: ${deploymentId}`);
    }

    if (deployment.deploymentType !== 'repo') {
      throw new Error('Can only delete repository deployments with this method');
    }

    if (!deployment.repositoryUrl) {
      // No repo to delete, just remove the record
      await this.deploymentRepository.delete(deploymentId);
      return { success: true };
    }

    try {
      // Parse owner/repo from URL
      const parsed = this.gitHubRepoProvider.parseRepoUrl(deployment.repositoryUrl);
      if (!parsed) {
        throw new Error(`Invalid repository URL: ${deployment.repositoryUrl}`);
      }

      const deleted = await this.gitHubRepoProvider.deleteRepository(parsed.owner, parsed.repo);
      if (deleted) {
        await this.deploymentRepository.delete(deploymentId);
        return { success: true };
      } else {
        return { success: false, error: 'Failed to delete repository from GitHub' };
      }
    } catch (error) {
      this.logger.error(`Failed to delete repository deployment: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Deploy to enterprise (stub - not yet implemented)
   */
  async deployToEnterprise(
    conversationId: string,
    options: EnterpriseDeploymentOptions = {},
  ): Promise<DeploymentResult> {
    this.logger.log(`Enterprise deployment requested for conversation: ${conversationId}`);
    this.logger.log(`Options: ${JSON.stringify(options)}`);

    throw new NotImplementedException(
      'Enterprise deployment is not yet available. ' +
      'This feature will include custom domains, CDN support, and regional deployments. ' +
      'Please use GitHub repository or Gist deployment for now.',
    );
  }

  /**
   * Read generated files from the filesystem
   */
  private async getGeneratedFiles(conversationId: string): Promise<DeploymentFile[]> {
    const serverDir = join(this.generatedServersDir, conversationId);

    if (!existsSync(serverDir)) {
      this.logger.warn(`Server directory not found: ${serverDir}`);
      return [];
    }

    const files: DeploymentFile[] = [];

    const readDirectory = (dir: string, basePath: string = ''): void => {
      const entries = readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
          // Skip node_modules and other common non-essential directories
          if (!['node_modules', '.git', 'dist'].includes(entry.name)) {
            readDirectory(fullPath, relativePath);
          }
        } else if (entry.isFile()) {
          try {
            const content = readFileSync(fullPath, 'utf-8');
            files.push({
              path: relativePath,
              content,
            });
          } catch (error) {
            this.logger.warn(`Failed to read file ${fullPath}: ${error.message}`);
          }
        }
      }
    };

    readDirectory(serverDir);
    return files;
  }

  /**
   * Extract server name from conversation
   */
  private getServerName(conversation: Conversation): string {
    // Try to extract from conversation state or metadata
    const state = conversation.state as { serverName?: string; intent?: string } | null;

    if (state?.serverName) {
      return state.serverName;
    }

    // Generate a default name
    return `mcp-server-${conversation.id.slice(0, 8)}`;
  }

  /**
   * Extract tool information from conversation state
   */
  private getToolsFromConversation(conversation: Conversation): McpToolInfo[] {
    const state = conversation.state as {
      tools?: Array<{ name: string; description: string }>;
      generatedTools?: Array<{ name: string; description: string }>;
    } | null;

    // Try to get tools from conversation state
    const tools = state?.tools || state?.generatedTools || [];

    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description || `Tool: ${tool.name}`,
    }));
  }
}
