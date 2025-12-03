import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { exec } from 'child_process';
import { promisify } from 'util';
import axios from 'axios';

const execAsync = promisify(exec);

@Injectable()
export class ContainerRegistryService {
  private readonly logger = new Logger(ContainerRegistryService.name);
  private readonly registry: string;
  private readonly owner: string;
  private readonly repo: string;
  private readonly localRegistry: string = 'localhost:5000';

  constructor(private readonly configService: ConfigService) {
    this.registry = this.configService.get<string>('GHCR_REGISTRY', 'ghcr.io');
    this.owner = this.configService.get<string>('GHCR_OWNER');
    this.repo = this.configService.get<string>('GHCR_REPO', 'mcp-servers');
  }

  /**
   * Check if running in local development mode
   */
  private isLocalDev(): boolean {
    return this.configService.get<string>('LOCAL_DEV') === 'true';
  }

  /**
   * Get the registry to use (local or GHCR)
   */
  private getRegistry(): string {
    if (this.isLocalDev()) {
      return this.localRegistry;
    }
    return this.registry;
  }

  /**
   * Get full image name for a server
   */
  getImageName(serverId: string, tag: string = 'latest'): string {
    if (this.isLocalDev()) {
      // Local registry: localhost:5000/server-id:tag
      return `${this.localRegistry}/${serverId}:${tag}`;
    }
    // GHCR: ghcr.io/owner/repo/server-id:tag
    return `${this.registry}/${this.owner}/${this.repo}/${serverId}:${tag}`;
  }

  /**
   * Login to GHCR using GitHub token
   * Skipped in LOCAL_DEV mode (local registry has no auth)
   */
  async login(): Promise<void> {
    if (this.isLocalDev()) {
      this.logger.log('LOCAL_DEV mode - skipping registry login (local registry has no auth)');
      return;
    }

    const token = this.configService.get<string>('GITHUB_TOKEN');
    if (!token) {
      this.logger.warn('GITHUB_TOKEN not configured - GHCR login skipped');
      return;
    }

    if (!this.owner) {
      this.logger.warn('GHCR_OWNER not configured - GHCR login skipped');
      return;
    }

    try {
      // Use stdin for password to avoid shell escaping issues
      await execAsync(
        `echo "${token}" | docker login ${this.registry} -u ${this.owner} --password-stdin`
      );
      this.logger.log(`Logged in to GHCR (${this.registry}) as ${this.owner}`);
    } catch (error) {
      this.logger.error(`Failed to login to GHCR: ${error.message}`);
      throw error;
    }
  }

  /**
   * Build and push Docker image to registry (GHCR or local)
   */
  async buildAndPush(
    serverDir: string,
    serverId: string,
    tag: string = 'latest'
  ): Promise<string> {
    const imageName = this.getImageName(serverId, tag);
    const targetRegistry = this.isLocalDev() ? 'local registry (localhost:5000)' : 'GHCR';

    // Build the image
    this.logger.log(`Building image: ${imageName} for ${targetRegistry}`);
    try {
      const { stdout: buildOutput } = await execAsync(
        `docker build -t ${imageName} ${serverDir}`,
        { maxBuffer: 10 * 1024 * 1024 } // 10MB buffer for build output
      );
      this.logger.debug(`Build output: ${buildOutput}`);
    } catch (error) {
      this.logger.error(`Failed to build image: ${error.message}`);
      throw new Error(`Docker build failed: ${error.message}`);
    }

    // Push the image
    this.logger.log(`Pushing image: ${imageName}`);
    try {
      const { stdout: pushOutput } = await execAsync(`docker push ${imageName}`);
      this.logger.debug(`Push output: ${pushOutput}`);
    } catch (error) {
      this.logger.error(`Failed to push image: ${error.message}`);
      throw new Error(`Docker push failed: ${error.message}`);
    }

    this.logger.log(`Successfully pushed image: ${imageName}`);
    return imageName;
  }

  /**
   * Delete image from registry (GHCR or local)
   */
  async deleteImage(serverId: string): Promise<void> {
    if (this.isLocalDev()) {
      // For local registry, delete via Docker CLI
      const imageName = this.getImageName(serverId);
      try {
        await execAsync(`docker rmi ${imageName} 2>/dev/null || true`);
        this.logger.log(`Deleted local image: ${serverId}`);
      } catch (error) {
        this.logger.warn(`Failed to delete local image (may not exist): ${error.message}`);
      }
      return;
    }

    const token = this.configService.get<string>('GITHUB_TOKEN');
    if (!token) {
      throw new Error('GITHUB_TOKEN not configured');
    }

    // GHCR package name includes the repo path
    const packageName = `${this.repo}/${serverId}`;
    const url = `https://api.github.com/user/packages/container/${encodeURIComponent(packageName)}`;

    try {
      await axios.delete(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
      this.logger.log(`Deleted image from GHCR: ${serverId}`);
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        this.logger.warn(`Image not found in GHCR: ${serverId}`);
        return;
      }
      this.logger.error(`Failed to delete image: ${error.message}`);
      throw new Error(`Failed to delete image from GHCR: ${error.message}`);
    }
  }

  /**
   * Check if an image exists in registry (GHCR or local)
   */
  async imageExists(serverId: string, tag: string = 'latest'): Promise<boolean> {
    if (this.isLocalDev()) {
      // Check local Docker images
      const imageName = this.getImageName(serverId, tag);
      try {
        await execAsync(`docker image inspect ${imageName}`);
        return true;
      } catch {
        return false;
      }
    }

    const token = this.configService.get<string>('GITHUB_TOKEN');
    if (!token) {
      return false;
    }

    const packageName = `${this.repo}/${serverId}`;
    const url = `https://api.github.com/user/packages/container/${encodeURIComponent(packageName)}/versions`;

    try {
      const response = await axios.get(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });

      // Check if the specific tag exists
      const versions = response.data as Array<{ metadata?: { container?: { tags?: string[] } } }>;
      return versions.some(
        (v) => v.metadata?.container?.tags?.includes(tag)
      );
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Tag an existing image with a new tag
   */
  async tagImage(serverId: string, sourceTag: string, targetTag: string): Promise<string> {
    const sourceImage = this.getImageName(serverId, sourceTag);
    const targetImage = this.getImageName(serverId, targetTag);

    try {
      await execAsync(`docker tag ${sourceImage} ${targetImage}`);
      await execAsync(`docker push ${targetImage}`);
      this.logger.log(`Tagged ${sourceImage} as ${targetImage}`);
      return targetImage;
    } catch (error) {
      this.logger.error(`Failed to tag image: ${error.message}`);
      throw new Error(`Failed to tag image: ${error.message}`);
    }
  }
}
