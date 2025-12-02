import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { nanoid } from 'nanoid';
import {
  HostedServer,
  HostedServerStatus,
} from '../database/entities/hosted-server.entity';
import { Deployment } from '../database/entities/deployment.entity';
import { ContainerRegistryService } from './services/container-registry.service';
import { ManifestGeneratorService } from './services/manifest-generator.service';
import { GitOpsService } from './services/gitops.service';
import { ConfigService } from '@nestjs/config';

export interface DeploymentResult {
  success: boolean;
  serverId: string;
  endpointUrl: string;
  status: HostedServerStatus;
  error?: string;
}

@Injectable()
export class HostingService {
  private readonly logger = new Logger(HostingService.name);
  private readonly domain: string;
  private readonly namespace: string;

  constructor(
    @InjectRepository(HostedServer)
    private hostedServerRepo: Repository<HostedServer>,
    @InjectRepository(Deployment)
    private deploymentRepo: Repository<Deployment>,
    private containerRegistryService: ContainerRegistryService,
    private manifestGeneratorService: ManifestGeneratorService,
    private gitOpsService: GitOpsService,
    private configService: ConfigService,
  ) {
    this.domain = this.configService.get(
      'MCP_HOSTING_DOMAIN',
      'mcp.example.com',
    );
    this.namespace = this.configService.get('K8S_NAMESPACE', 'mcp-servers');
  }

  /**
   * Deploy a generated MCP server to the K8s cluster
   */
  async deployToCloud(conversationId: string): Promise<DeploymentResult> {
    // 1. Get deployment info from conversation
    const deployment = await this.deploymentRepo.findOne({
      where: { conversationId },
      order: { createdAt: 'DESC' },
    });

    if (!deployment) {
      throw new NotFoundException(
        `No deployment found for conversation ${conversationId}`,
      );
    }

    if (!deployment.serverName) {
      throw new BadRequestException(
        'Deployment does not have server metadata (serverName required)',
      );
    }

    // 2. Generate unique server ID
    const serverId = this.generateServerId(deployment.serverName);
    const endpointUrl = `https://${serverId}.${this.domain}`;

    // 3. Create hosted server record
    const hostedServer = this.hostedServerRepo.create({
      conversationId,
      serverName: deployment.serverName,
      serverId,
      description: deployment.description,
      dockerImage: '', // Will be set after push
      endpointUrl,
      status: 'pending',
      tools: deployment.tools,
      envVarNames: deployment.envVars?.map((e) => e.name) || [],
    });

    await this.hostedServerRepo.save(hostedServer);

    try {
      // 4. Build and push Docker image
      await this.updateStatus(hostedServer, 'building', 'Building Docker image...');

      const serverDir = deployment.localPath; // Path to generated server files
      if (!serverDir) {
        throw new BadRequestException('Deployment does not have localPath');
      }

      const dockerImage = await this.containerRegistryService.buildAndPush(
        serverDir,
        serverId,
        'latest',
      );

      hostedServer.dockerImage = dockerImage;
      await this.hostedServerRepo.save(hostedServer);

      // 5. Generate K8s manifests
      await this.updateStatus(
        hostedServer,
        'deploying',
        'Generating Kubernetes manifests...',
      );

      const manifests = this.manifestGeneratorService.generateManifests({
        serverId,
        serverName: deployment.serverName,
        dockerImage,
        imageTag: 'latest',
        domain: this.domain,
        namespace: this.namespace,
      });

      const kustomization =
        this.manifestGeneratorService.generateKustomization(serverId);

      // 6. Commit to GitOps repo
      await this.updateStatus(
        hostedServer,
        'deploying',
        'Deploying to Kubernetes cluster...',
      );

      const commitResult = await this.gitOpsService.deployServer(
        serverId,
        manifests,
        kustomization,
      );

      if (!commitResult.success) {
        throw new Error(`GitOps commit failed: ${commitResult.error}`);
      }

      // 7. Mark as running (ArgoCD will handle actual deployment)
      await this.updateStatus(hostedServer, 'running', 'Server deployed successfully');
      hostedServer.deployedAt = new Date();
      hostedServer.k8sDeploymentName = `mcp-${serverId}`;
      await this.hostedServerRepo.save(hostedServer);

      this.logger.log(`Deployed MCP server: ${serverId} at ${endpointUrl}`);

      return {
        success: true,
        serverId,
        endpointUrl,
        status: 'running',
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      await this.updateStatus(hostedServer, 'failed', errorMessage);
      this.logger.error(`Deployment failed for ${serverId}: ${errorMessage}`);

      return {
        success: false,
        serverId,
        endpointUrl,
        status: 'failed',
        error: errorMessage,
      };
    }
  }

  /**
   * Stop a hosted server (scale to 0)
   */
  async stopServer(serverId: string): Promise<void> {
    const server = await this.getServerByIdOrFail(serverId);

    // Update manifests with replicas: 0
    const manifests = this.manifestGeneratorService.generateManifests({
      serverId,
      serverName: server.serverName,
      dockerImage: server.dockerImage,
      imageTag: server.imageTag,
      domain: this.domain,
      namespace: this.namespace,
    });

    // Modify deployment to have 0 replicas
    const stoppedDeployment = manifests.deployment.replace(
      'replicas: 1',
      'replicas: 0',
    );

    await this.gitOpsService.updateServer(
      serverId,
      { ...manifests, deployment: stoppedDeployment },
      this.manifestGeneratorService.generateKustomization(serverId),
    );

    await this.updateStatus(server, 'stopped', 'Server stopped');
    server.stoppedAt = new Date();
    await this.hostedServerRepo.save(server);
  }

  /**
   * Start a stopped server (scale to 1)
   */
  async startServer(serverId: string): Promise<void> {
    const server = await this.getServerByIdOrFail(serverId);

    if (server.status !== 'stopped') {
      throw new BadRequestException('Server is not stopped');
    }

    const manifests = this.manifestGeneratorService.generateManifests({
      serverId,
      serverName: server.serverName,
      dockerImage: server.dockerImage,
      imageTag: server.imageTag,
      domain: this.domain,
      namespace: this.namespace,
    });

    await this.gitOpsService.updateServer(
      serverId,
      manifests,
      this.manifestGeneratorService.generateKustomization(serverId),
    );

    await this.updateStatus(server, 'running', 'Server started');
    server.stoppedAt = null;
    await this.hostedServerRepo.save(server);
  }

  /**
   * Delete a hosted server completely
   */
  async deleteServer(serverId: string): Promise<void> {
    const server = await this.getServerByIdOrFail(serverId);

    // Remove from GitOps repo
    await this.gitOpsService.removeServer(serverId);

    // Delete Docker image (optional, can keep for rollback)
    try {
      await this.containerRegistryService.deleteImage(serverId);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      this.logger.warn(`Failed to delete image for ${serverId}: ${errorMessage}`);
    }

    // Soft delete in database
    await this.updateStatus(server, 'deleted', 'Server deleted');
    server.deletedAt = new Date();
    await this.hostedServerRepo.save(server);
  }

  /**
   * Get all servers for a user
   */
  async getServers(userId?: string): Promise<HostedServer[]> {
    const query = this.hostedServerRepo
      .createQueryBuilder('server')
      .where('server.status != :deleted', { deleted: 'deleted' })
      .orderBy('server.createdAt', 'DESC');

    if (userId) {
      query.andWhere('server.userId = :userId', { userId });
    }

    return query.getMany();
  }

  /**
   * Get server by ID
   */
  async getServer(serverId: string): Promise<HostedServer> {
    return this.getServerByIdOrFail(serverId);
  }

  /**
   * Increment request count (called by MCP proxy)
   */
  async trackRequest(serverId: string): Promise<void> {
    await this.hostedServerRepo.increment({ serverId }, 'requestCount', 1);
    await this.hostedServerRepo.update(
      { serverId },
      { lastRequestAt: new Date() },
    );
  }

  // --- Helper Methods ---

  private generateServerId(serverName: string): string {
    const prefix = serverName
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 20);

    const suffix = nanoid(8).toLowerCase();
    return `${prefix}-${suffix}`;
  }

  private async getServerByIdOrFail(serverId: string): Promise<HostedServer> {
    const server = await this.hostedServerRepo.findOne({
      where: { serverId },
    });

    if (!server) {
      throw new NotFoundException(`Server not found: ${serverId}`);
    }

    return server;
  }

  private async updateStatus(
    server: HostedServer,
    status: HostedServerStatus,
    message: string,
  ): Promise<void> {
    server.status = status;
    server.statusMessage = message;
    server.lastStatusChange = new Date();
    await this.hostedServerRepo.save(server);
  }
}
