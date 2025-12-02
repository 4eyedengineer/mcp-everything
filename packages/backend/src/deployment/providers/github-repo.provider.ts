import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Octokit } from '@octokit/rest';
import { GitHubRepoResult, DeploymentFile } from '../types/deployment.types';

@Injectable()
export class GitHubRepoProvider {
  private readonly logger = new Logger(GitHubRepoProvider.name);
  private octokit: Octokit;
  private owner: string;

  constructor(private configService: ConfigService) {
    const githubToken = this.configService.get<string>('GITHUB_TOKEN');
    this.octokit = new Octokit({
      auth: githubToken,
      request: {
        timeout: 30000,
      },
    });
  }

  /**
   * Get the authenticated user's login name
   */
  private async getAuthenticatedUser(): Promise<string> {
    if (this.owner) return this.owner;

    const { data } = await this.octokit.rest.users.getAuthenticated();
    this.owner = data.login;
    return this.owner;
  }

  /**
   * Create a new GitHub repository
   */
  async createRepository(
    name: string,
    description: string,
    isPrivate: boolean = false,
  ): Promise<{ owner: string; repo: string; url: string }> {
    try {
      const { data } = await this.octokit.rest.repos.createForAuthenticatedUser({
        name,
        description,
        private: isPrivate,
        auto_init: true, // Initialize with README
      });

      this.logger.log(`Created repository: ${data.full_name}`);

      return {
        owner: data.owner.login,
        repo: data.name,
        url: data.html_url,
      };
    } catch (error) {
      this.logger.error(`Failed to create repository: ${error.message}`);
      throw error;
    }
  }

  /**
   * Push files to a GitHub repository
   */
  async pushFiles(
    owner: string,
    repo: string,
    files: DeploymentFile[],
    commitMessage: string = 'Initial MCP server commit',
  ): Promise<void> {
    try {
      // Get the default branch
      const { data: repoData } = await this.octokit.rest.repos.get({
        owner,
        repo,
      });
      const defaultBranch = repoData.default_branch;

      // Get the latest commit SHA
      const { data: refData } = await this.octokit.rest.git.getRef({
        owner,
        repo,
        ref: `heads/${defaultBranch}`,
      });
      const latestCommitSha = refData.object.sha;

      // Get the tree SHA from the latest commit
      const { data: commitData } = await this.octokit.rest.git.getCommit({
        owner,
        repo,
        commit_sha: latestCommitSha,
      });
      const baseTreeSha = commitData.tree.sha;

      // Create blobs for each file
      const blobs = await Promise.all(
        files.map(async (file) => {
          const { data } = await this.octokit.rest.git.createBlob({
            owner,
            repo,
            content: Buffer.from(file.content).toString('base64'),
            encoding: 'base64',
          });
          return {
            path: file.path,
            mode: '100644' as const,
            type: 'blob' as const,
            sha: data.sha,
          };
        }),
      );

      // Create a new tree
      const { data: newTree } = await this.octokit.rest.git.createTree({
        owner,
        repo,
        base_tree: baseTreeSha,
        tree: blobs,
      });

      // Create a new commit
      const { data: newCommit } = await this.octokit.rest.git.createCommit({
        owner,
        repo,
        message: commitMessage,
        tree: newTree.sha,
        parents: [latestCommitSha],
      });

      // Update the reference
      await this.octokit.rest.git.updateRef({
        owner,
        repo,
        ref: `heads/${defaultBranch}`,
        sha: newCommit.sha,
      });

      this.logger.log(`Pushed ${files.length} files to ${owner}/${repo}`);
    } catch (error) {
      this.logger.error(`Failed to push files: ${error.message}`);
      throw error;
    }
  }

  /**
   * Deploy files to a new GitHub repository
   */
  async deploy(
    serverName: string,
    files: DeploymentFile[],
    description: string,
    isPrivate: boolean = false,
  ): Promise<GitHubRepoResult> {
    try {
      // Sanitize repository name
      const repoName = this.sanitizeRepoName(serverName);

      // Create repository
      const { owner, repo, url } = await this.createRepository(
        repoName,
        description,
        isPrivate,
      );

      // Wait a moment for the repo to be ready
      await this.delay(1000);

      // Push files
      await this.pushFiles(owner, repo, files, `Add generated MCP server: ${serverName}`);

      // Generate Codespace URL
      const codespaceUrl = `https://github.com/codespaces/new?repo=${owner}/${repo}`;

      return {
        success: true,
        repositoryUrl: url,
        codespaceUrl,
      };
    } catch (error) {
      this.logger.error(`Deployment failed: ${error.message}`);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Check if a repository exists
   */
  async repositoryExists(owner: string, repo: string): Promise<boolean> {
    try {
      await this.octokit.rest.repos.get({ owner, repo });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Sanitize a string to be a valid GitHub repository name
   */
  private sanitizeRepoName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 100); // GitHub has a 100 char limit
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
