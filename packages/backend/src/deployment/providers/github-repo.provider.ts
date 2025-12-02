import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Octokit } from '@octokit/rest';
import * as sodium from 'libsodium-wrappers';
import { GitHubRepoResult, DeploymentFile } from '../types/deployment.types';
import { CollectedEnvVar } from '../../types/env-variable.types';

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
  ): Promise<{ owner: string; repo: string; url: string; cloneUrl: string }> {
    return this.withRateLimitRetry(async () => {
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
        cloneUrl: data.clone_url,
      };
    });
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
    envVars?: CollectedEnvVar[],
  ): Promise<GitHubRepoResult> {
    try {
      // Sanitize repository name
      const baseRepoName = this.sanitizeRepoName(serverName);

      // Get authenticated user for conflict checking
      const authenticatedUser = await this.getAuthenticatedUser();

      // Handle naming conflicts by trying with timestamp suffixes
      let repoName = baseRepoName;
      let attempts = 0;
      const maxAttempts = 3;

      while (attempts < maxAttempts) {
        const exists = await this.repositoryExists(authenticatedUser, repoName);
        if (!exists) break;

        this.logger.warn(`Repository ${repoName} already exists, trying with timestamp suffix`);
        repoName = `${baseRepoName}-${Date.now()}`;
        attempts++;
      }

      if (attempts >= maxAttempts) {
        throw new Error(`Failed to find unique repository name after ${maxAttempts} attempts`);
      }

      // Create repository
      const { owner, repo, url, cloneUrl } = await this.createRepository(
        repoName,
        description,
        isPrivate,
      );

      // Wait a moment for the repo to be ready
      await this.delay(1000);

      // Inject CI badge into README if present
      const filesWithBadge = this.injectCIBadge(files, owner, repo);

      // Push files
      await this.pushFiles(owner, repo, filesWithBadge, `Add generated MCP server: ${serverName}`);

      // Create secrets for environment variables if provided
      if (envVars && envVars.length > 0) {
        this.logger.log(`Creating ${envVars.length} repository secrets`);
        await this.createSecrets(owner, repo, envVars);
      }

      // Generate Codespace URL
      const codespaceUrl = `https://github.com/codespaces/new?repo=${owner}/${repo}`;

      return {
        success: true,
        repositoryUrl: url,
        cloneUrl,
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
   * Create repository secrets for environment variables
   *
   * Uses GitHub's encrypted secrets API with libsodium for encryption.
   * Secrets are stored encrypted and can only be accessed by GitHub Actions.
   */
  async createSecrets(
    owner: string,
    repo: string,
    envVars: CollectedEnvVar[],
  ): Promise<{ success: boolean; created: string[]; failed: string[] }> {
    const created: string[] = [];
    const failed: string[] = [];

    try {
      // Initialize libsodium
      await sodium.ready;

      // Get the repository public key for encryption
      const { data: publicKey } = await this.octokit.actions.getRepoPublicKey({
        owner,
        repo,
      });

      // Create each secret
      for (const envVar of envVars) {
        // Skip empty or skipped values
        if (envVar.skipped || !envVar.value) {
          this.logger.debug(`Skipping secret ${envVar.name}: no value provided`);
          continue;
        }

        try {
          // Encrypt the secret value
          const binKey = sodium.from_base64(publicKey.key, sodium.base64_variants.ORIGINAL);
          const binSec = sodium.from_string(envVar.value);
          const encBytes = sodium.crypto_box_seal(binSec, binKey);
          const encryptedValue = sodium.to_base64(encBytes, sodium.base64_variants.ORIGINAL);

          // Create or update the secret
          await this.octokit.actions.createOrUpdateRepoSecret({
            owner,
            repo,
            secret_name: envVar.name,
            encrypted_value: encryptedValue,
            key_id: publicKey.key_id,
          });

          created.push(envVar.name);
          this.logger.log(`Created secret: ${envVar.name}`);
        } catch (error) {
          failed.push(envVar.name);
          this.logger.error(`Failed to create secret ${envVar.name}: ${error.message}`);
        }
      }

      return {
        success: failed.length === 0,
        created,
        failed,
      };
    } catch (error) {
      this.logger.error(`Failed to create secrets: ${error.message}`);
      return {
        success: false,
        created,
        failed: envVars.map(v => v.name),
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
   * Delete a GitHub repository
   * Note: Requires delete_repo scope on the GitHub token
   */
  async deleteRepository(owner: string, repo: string): Promise<boolean> {
    return this.withRateLimitRetry(async () => {
      try {
        await this.octokit.rest.repos.delete({ owner, repo });
        this.logger.log(`Deleted repository: ${owner}/${repo}`);
        return true;
      } catch (error) {
        this.logger.error(`Failed to delete repository ${owner}/${repo}: ${error.message}`);
        throw error;
      }
    });
  }

  /**
   * Parse owner and repo from a GitHub repository URL
   */
  parseRepoUrl(url: string): { owner: string; repo: string } | null {
    // Handle various GitHub URL formats:
    // https://github.com/owner/repo
    // https://github.com/owner/repo.git
    // git@github.com:owner/repo.git
    const httpsMatch = url.match(/github\.com\/([^/]+)\/([^/.]+)/);
    if (httpsMatch) {
      return { owner: httpsMatch[1], repo: httpsMatch[2] };
    }

    const sshMatch = url.match(/github\.com:([^/]+)\/([^/.]+)/);
    if (sshMatch) {
      return { owner: sshMatch[1], repo: sshMatch[2] };
    }

    return null;
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

  /**
   * Inject CI status badge into README.md if present
   */
  private injectCIBadge(
    files: DeploymentFile[],
    owner: string,
    repo: string,
  ): DeploymentFile[] {
    const readmeIndex = files.findIndex(
      (f) => f.path.toLowerCase() === 'readme.md',
    );
    if (readmeIndex === -1) return files;

    const badge = `![Build Status](https://github.com/${owner}/${repo}/actions/workflows/test.yml/badge.svg)\n\n`;
    const content = files[readmeIndex].content;
    const firstLineEnd = content.indexOf('\n');

    // If no newline found, append badge at the end
    const newContent =
      firstLineEnd === -1
        ? content + '\n\n' + badge
        : content.slice(0, firstLineEnd + 1) + '\n' + badge + content.slice(firstLineEnd + 1);

    const newFiles = [...files];
    newFiles[readmeIndex] = { ...files[readmeIndex], content: newContent };

    this.logger.log(`Injected CI badge into README for ${owner}/${repo}`);
    return newFiles;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Execute a function with rate limit retry logic
   */
  private async withRateLimitRetry<T>(
    fn: () => Promise<T>,
    maxRetries: number = 3,
  ): Promise<T> {
    let lastError: Error;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;

        // Check if it's a rate limit error (403 or 429)
        const status = error.status || error.response?.status;
        if (status !== 403 && status !== 429) {
          throw error;
        }

        if (attempt >= maxRetries) {
          this.logger.error(`Rate limit exceeded after ${maxRetries + 1} attempts`);
          throw error;
        }

        // Get retry delay from headers or use exponential backoff
        let delayMs = Math.pow(2, attempt + 1) * 1000; // 2s, 4s, 8s

        const resetHeader =
          error.response?.headers?.['x-ratelimit-reset'] ||
          error.headers?.['x-ratelimit-reset'];

        if (resetHeader) {
          const resetTime = parseInt(resetHeader, 10) * 1000;
          const waitTime = resetTime - Date.now();
          if (waitTime > 0 && waitTime < 60000) {
            // Cap at 60 seconds
            delayMs = waitTime + 1000; // Add 1s buffer
          }
        }

        this.logger.warn(
          `Rate limit hit, waiting ${delayMs}ms before retry ${attempt + 1}/${maxRetries}`,
        );
        await this.delay(delayMs);
      }
    }

    throw lastError;
  }
}
