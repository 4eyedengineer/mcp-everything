import { Injectable, Logger, NotFoundException } from '@nestjs/common';
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
import {
  DeploymentResult,
  DeploymentStatusResponse,
  DeploymentFile,
  DeploymentOptions,
} from './types/deployment.types';

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
  ) {
    this.generatedServersDir = join(process.cwd(), '../../generated-servers');
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
        throw new Error('No generated files found for this conversation');
      }

      const serverName = this.getServerName(conversation);

      // Always add .gitignore
      files.push(...this.gitignoreProvider.generateGitignoreFiles());

      // Always add CI workflow for GitHub repos
      files.push(...this.ciWorkflowProvider.generateCIWorkflowFiles(serverName));

      // Add devcontainer if requested
      if (options.includeDevContainer) {
        const devContainerFiles = this.devContainerProvider.generateDevContainerFiles(
          serverName,
          'typescript',
        );
        files.push(...devContainerFiles);
      }

      // Deploy to GitHub (default to private repos)
      const result = await this.gitHubRepoProvider.deploy(
        serverName,
        files,
        options.description || `MCP Server generated from conversation ${conversationId}`,
        options.isPrivate ?? true,
      );

      if (result.success) {
        // Update deployment record with success
        await this.deploymentRepository.update(savedDeployment.id, {
          status: 'success',
          repositoryUrl: result.repositoryUrl,
          codespaceUrl: result.codespaceUrl,
          deployedAt: new Date(),
        });

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
      // Update deployment record with failure
      await this.deploymentRepository.update(savedDeployment.id, {
        status: 'failed',
        errorMessage: error.message,
        deployedAt: new Date(),
      });

      return {
        success: false,
        deploymentId: savedDeployment.id,
        type: 'repo',
        urls: {},
        error: error.message,
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
        throw new Error('No generated files found for this conversation');
      }

      // Extract tools from conversation state
      const tools = this.getToolsFromConversation(conversation);

      // Deploy to Gist using single-file bundled format
      const result = await this.gistProvider.deploySingleFile(
        this.getServerName(conversation),
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
      // Update deployment record with failure
      await this.deploymentRepository.update(savedDeployment.id, {
        status: 'failed',
        errorMessage: error.message,
        deployedAt: new Date(),
      });

      return {
        success: false,
        deploymentId: savedDeployment.id,
        type: 'gist',
        urls: {},
        error: error.message,
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
   */
  async retryDeployment(deploymentId: string): Promise<DeploymentResult> {
    const deployment = await this.deploymentRepository.findOneBy({ id: deploymentId });

    if (!deployment) {
      throw new NotFoundException(`Deployment not found: ${deploymentId}`);
    }

    if (deployment.status !== 'failed') {
      throw new Error('Can only retry failed deployments');
    }

    const options = (deployment.metadata?.options as DeploymentOptions) || {};

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
