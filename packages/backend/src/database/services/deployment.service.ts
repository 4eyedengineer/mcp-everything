import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Deployment } from '../entities/deployment.entity';

export interface DeploymentUrls {
  repositoryUrl?: string;
  gistUrl?: string;
  codespaceUrl?: string;
}

@Injectable()
export class DeploymentService {
  private readonly logger = new Logger(DeploymentService.name);

  constructor(
    @InjectRepository(Deployment)
    private readonly deploymentRepository: Repository<Deployment>,
  ) {}

  /**
   * Create a new deployment record
   */
  async createDeployment(
    conversationId: string,
    deploymentType: 'gist' | 'repo' | 'none',
    metadata?: Record<string, any>,
  ): Promise<Deployment> {
    const deployment = this.deploymentRepository.create({
      conversationId,
      deploymentType,
      status: 'pending',
      metadata,
    });

    const saved = await this.deploymentRepository.save(deployment);
    this.logger.log(`Created deployment ${saved.id} for conversation ${conversationId}`);
    return saved;
  }

  /**
   * Mark a deployment as successful with URLs
   */
  async markSuccess(id: string, urls: DeploymentUrls): Promise<Deployment> {
    await this.deploymentRepository.update(id, {
      status: 'success',
      repositoryUrl: urls.repositoryUrl,
      gistUrl: urls.gistUrl,
      codespaceUrl: urls.codespaceUrl,
      deployedAt: new Date(),
    });

    const deployment = await this.deploymentRepository.findOneBy({ id });
    this.logger.log(`Deployment ${id} marked as success`);
    return deployment;
  }

  /**
   * Mark a deployment as failed with error message
   */
  async markFailed(id: string, errorMessage: string): Promise<Deployment> {
    await this.deploymentRepository.update(id, {
      status: 'failed',
      errorMessage,
      deployedAt: new Date(),
    });

    const deployment = await this.deploymentRepository.findOneBy({ id });
    this.logger.warn(`Deployment ${id} marked as failed: ${errorMessage}`);
    return deployment;
  }

  /**
   * Get all deployments for a conversation
   */
  async getDeploymentsByConversation(conversationId: string): Promise<Deployment[]> {
    return this.deploymentRepository.find({
      where: { conversationId },
      order: { createdAt: 'DESC' },
    });
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
   * Get a deployment by ID
   */
  async getDeploymentById(id: string): Promise<Deployment | null> {
    return this.deploymentRepository.findOneBy({ id });
  }

  /**
   * Update deployment metadata
   */
  async updateMetadata(id: string, metadata: Record<string, any>): Promise<Deployment> {
    const deployment = await this.deploymentRepository.findOneBy({ id });
    if (deployment) {
      deployment.metadata = { ...deployment.metadata, ...metadata };
      return this.deploymentRepository.save(deployment);
    }
    return null;
  }
}
