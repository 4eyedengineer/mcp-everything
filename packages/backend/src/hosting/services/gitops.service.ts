import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Octokit } from '@octokit/rest';
import { GeneratedManifests } from './manifest-generator.service';
import * as fs from 'fs/promises';
import * as path from 'path';

export interface GitOpsCommitResult {
  success: boolean;
  commitSha?: string;
  commitUrl?: string;
  localPath?: string;
  error?: string;
}

@Injectable()
export class GitOpsService {
  private readonly logger = new Logger(GitOpsService.name);
  private readonly octokit: Octokit;
  private readonly owner: string;
  private readonly repo: string;
  private readonly branch: string;
  private readonly localGitOpsPath: string;

  constructor(private configService: ConfigService) {
    this.octokit = new Octokit({
      auth: this.configService.get('GITHUB_TOKEN'),
    });
    this.owner = this.configService.get('GITOPS_OWNER', '4eyedengineer');
    this.repo = this.configService.get('GITOPS_REPO', 'mcp-server-deployments');
    this.branch = this.configService.get('GITOPS_BRANCH', 'main');
    // Local GitOps path for LOCAL_DEV mode
    this.localGitOpsPath = this.configService.get(
      'LOCAL_GITOPS_PATH',
      path.join(process.cwd(), 'k8s', 'local-gitops', 'servers'),
    );
  }

  /**
   * Check if running in local development mode
   */
  private isLocalDev(): boolean {
    return this.configService.get<string>('LOCAL_DEV') === 'true';
  }

  /**
   * Deploy server by writing manifests (to local filesystem or GitHub repo)
   */
  async deployServer(
    serverId: string,
    manifests: GeneratedManifests,
    kustomization: string,
  ): Promise<GitOpsCommitResult> {
    // LOCAL_DEV mode: write to local filesystem
    if (this.isLocalDev()) {
      return this.deployServerLocal(serverId, manifests, kustomization);
    }

    // Production mode: commit to GitHub
    return this.deployServerGitHub(serverId, manifests, kustomization);
  }

  /**
   * Deploy server manifests to local filesystem (LOCAL_DEV mode)
   */
  private async deployServerLocal(
    serverId: string,
    manifests: GeneratedManifests,
    kustomization: string,
  ): Promise<GitOpsCommitResult> {
    try {
      const serverDir = path.join(this.localGitOpsPath, serverId);

      // Create server directory
      await fs.mkdir(serverDir, { recursive: true });

      // Write manifest files
      await Promise.all([
        fs.writeFile(path.join(serverDir, 'deployment.yaml'), manifests.deployment),
        fs.writeFile(path.join(serverDir, 'service.yaml'), manifests.service),
        fs.writeFile(path.join(serverDir, 'ingress.yaml'), manifests.ingress),
        fs.writeFile(path.join(serverDir, 'kustomization.yaml'), kustomization),
      ]);

      this.logger.log(`LOCAL_DEV: Wrote manifests for ${serverId} to ${serverDir}`);

      return {
        success: true,
        localPath: serverDir,
      };
    } catch (error) {
      this.logger.error(`Failed to write local manifests for ${serverId}: ${error.message}`);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Deploy server by committing manifests to GitOps GitHub repo
   */
  private async deployServerGitHub(
    serverId: string,
    manifests: GeneratedManifests,
    kustomization: string,
  ): Promise<GitOpsCommitResult> {
    try {
      const basePath = `servers/${serverId}`;

      // Get current commit SHA for the branch
      const { data: ref } = await this.octokit.git.getRef({
        owner: this.owner,
        repo: this.repo,
        ref: `heads/${this.branch}`,
      });
      const currentSha = ref.object.sha;

      // Get current tree
      const { data: currentCommit } = await this.octokit.git.getCommit({
        owner: this.owner,
        repo: this.repo,
        commit_sha: currentSha,
      });

      // Create blobs for each file
      const files = [
        { path: `${basePath}/deployment.yaml`, content: manifests.deployment },
        { path: `${basePath}/service.yaml`, content: manifests.service },
        { path: `${basePath}/ingress.yaml`, content: manifests.ingress },
        { path: `${basePath}/kustomization.yaml`, content: kustomization },
      ];

      const blobs = await Promise.all(
        files.map(async (file) => {
          const { data: blob } = await this.octokit.git.createBlob({
            owner: this.owner,
            repo: this.repo,
            content: Buffer.from(file.content).toString('base64'),
            encoding: 'base64',
          });
          return {
            path: file.path,
            mode: '100644' as const,
            type: 'blob' as const,
            sha: blob.sha,
          };
        }),
      );

      // Create new tree
      const { data: newTree } = await this.octokit.git.createTree({
        owner: this.owner,
        repo: this.repo,
        base_tree: currentCommit.tree.sha,
        tree: blobs,
      });

      // Create commit
      const { data: newCommit } = await this.octokit.git.createCommit({
        owner: this.owner,
        repo: this.repo,
        message: `Deploy MCP server: ${serverId}`,
        tree: newTree.sha,
        parents: [currentSha],
      });

      // Update branch reference
      await this.octokit.git.updateRef({
        owner: this.owner,
        repo: this.repo,
        ref: `heads/${this.branch}`,
        sha: newCommit.sha,
      });

      this.logger.log(`Committed manifests for ${serverId}: ${newCommit.sha}`);

      return {
        success: true,
        commitSha: newCommit.sha,
        commitUrl: newCommit.html_url,
      };
    } catch (error) {
      this.logger.error(
        `Failed to commit manifests for ${serverId}: ${error.message}`,
      );
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Remove server by deleting its manifests (from local filesystem or GitHub repo)
   */
  async removeServer(serverId: string): Promise<GitOpsCommitResult> {
    // LOCAL_DEV mode: delete from local filesystem
    if (this.isLocalDev()) {
      return this.removeServerLocal(serverId);
    }

    // Production mode: remove from GitHub
    return this.removeServerGitHub(serverId);
  }

  /**
   * Remove server manifests from local filesystem (LOCAL_DEV mode)
   */
  private async removeServerLocal(serverId: string): Promise<GitOpsCommitResult> {
    try {
      const serverDir = path.join(this.localGitOpsPath, serverId);

      // Remove the server directory
      await fs.rm(serverDir, { recursive: true, force: true });

      this.logger.log(`LOCAL_DEV: Removed manifests for ${serverId} from ${serverDir}`);

      return {
        success: true,
        localPath: serverDir,
      };
    } catch (error) {
      this.logger.error(`Failed to remove local manifests for ${serverId}: ${error.message}`);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Remove server by deleting its directory from GitOps GitHub repo
   */
  private async removeServerGitHub(serverId: string): Promise<GitOpsCommitResult> {
    try {
      const basePath = `servers/${serverId}`;

      // Get current commit SHA
      const { data: ref } = await this.octokit.git.getRef({
        owner: this.owner,
        repo: this.repo,
        ref: `heads/${this.branch}`,
      });
      const currentSha = ref.object.sha;

      // Get current tree
      const { data: currentCommit } = await this.octokit.git.getCommit({
        owner: this.owner,
        repo: this.repo,
        commit_sha: currentSha,
      });

      // Get full tree (recursive)
      const { data: fullTree } = await this.octokit.git.getTree({
        owner: this.owner,
        repo: this.repo,
        tree_sha: currentCommit.tree.sha,
        recursive: 'true',
      });

      // Filter out files in the server directory
      const newTreeItems = fullTree.tree.filter(
        (item) => !item.path?.startsWith(basePath),
      );

      // Create new tree without the server directory
      const { data: newTree } = await this.octokit.git.createTree({
        owner: this.owner,
        repo: this.repo,
        tree: newTreeItems.map((item) => ({
          path: item.path!,
          mode: item.mode as '100644' | '100755' | '040000' | '160000' | '120000',
          type: item.type as 'blob' | 'tree' | 'commit',
          sha: item.sha,
        })),
      });

      // Create commit
      const { data: newCommit } = await this.octokit.git.createCommit({
        owner: this.owner,
        repo: this.repo,
        message: `Remove MCP server: ${serverId}`,
        tree: newTree.sha,
        parents: [currentSha],
      });

      // Update branch
      await this.octokit.git.updateRef({
        owner: this.owner,
        repo: this.repo,
        ref: `heads/${this.branch}`,
        sha: newCommit.sha,
      });

      this.logger.log(`Removed manifests for ${serverId}: ${newCommit.sha}`);

      return {
        success: true,
        commitSha: newCommit.sha,
        commitUrl: newCommit.html_url,
      };
    } catch (error) {
      this.logger.error(
        `Failed to remove manifests for ${serverId}: ${error.message}`,
      );
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Update server (e.g., new image tag)
   */
  async updateServer(
    serverId: string,
    manifests: GeneratedManifests,
    kustomization: string,
  ): Promise<GitOpsCommitResult> {
    // Same as deploy, will overwrite existing files
    return this.deployServer(serverId, manifests, kustomization);
  }
}
