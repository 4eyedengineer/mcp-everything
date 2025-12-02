import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Octokit } from '@octokit/rest';
import { GeneratedManifests } from './manifest-generator.service';

export interface GitOpsCommitResult {
  success: boolean;
  commitSha?: string;
  commitUrl?: string;
  error?: string;
}

@Injectable()
export class GitOpsService {
  private readonly logger = new Logger(GitOpsService.name);
  private readonly octokit: Octokit;
  private readonly owner: string;
  private readonly repo: string;
  private readonly branch: string;

  constructor(private configService: ConfigService) {
    this.octokit = new Octokit({
      auth: this.configService.get('GITHUB_TOKEN'),
    });
    this.owner = this.configService.get('GITOPS_OWNER', '4eyedengineer');
    this.repo = this.configService.get('GITOPS_REPO', 'mcp-server-deployments');
    this.branch = this.configService.get('GITOPS_BRANCH', 'main');
  }

  /**
   * Deploy server by committing manifests to GitOps repo
   */
  async deployServer(
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
   * Remove server by deleting its directory from GitOps repo
   */
  async removeServer(serverId: string): Promise<GitOpsCommitResult> {
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
