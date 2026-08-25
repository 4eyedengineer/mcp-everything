import { Injectable, Logger } from '@nestjs/common';
import { Octokit } from '@octokit/rest';
import { GistResult, DeploymentFile } from '../types/deployment.types';

export interface McpToolInfo {
  name: string;
  description: string;
  /**
   * The tool's JSON Schema, when the generated server declared one. Optional
   * because it is absent for tools generated before the schema was carried
   * through conversation.state (see DeploymentOrchestratorService
   * .getToolsFromConversation and the BackfillToolInputSchemas migration).
   */
  inputSchema?: Record<string, unknown>;
}

export interface SingleFileGistOptions {
  serverName: string;
  description: string;
  tools: McpToolInfo[];
  isPublic?: boolean;
}

/**
 * Creates/updates/deletes Gists under the CALLING USER's own GitHub
 * account. Every public method here takes the user's decrypted GitHub
 * OAuth token as its first argument (see GitHubService.getUserAccessToken)
 * rather than holding a shared, server-wide credential - a Gist published
 * on someone's behalf must land in their own account, never a
 * platform-owned one. There is deliberately no server-token fallback: if
 * `githubToken` is empty, every method here fails clearly instead of
 * silently authenticating as the platform.
 */
@Injectable()
export class GistProvider {
  private readonly logger = new Logger(GistProvider.name);

  /**
   * Build a per-call Octokit client authenticated as the given user. Throws
   * (rather than falling back to any shared/server credential) when no
   * token is supplied, so every caller either gets a client scoped to the
   * right user or a clear, catchable failure - never a silently-wrong one.
   */
  private buildOctokit(githubToken: string): Octokit {
    if (!githubToken) {
      throw new Error(
        'GitHub account not connected. Connect your GitHub account to deploy to a Gist, or use Download instead.',
      );
    }
    return new Octokit({
      auth: githubToken,
      request: {
        timeout: 30000,
      },
    });
  }

  /**
   * Execute a function with rate limit retry logic
   * Handles GitHub API rate limits (403/429) with exponential backoff
   */
  private async withRateLimitRetry<T>(fn: () => Promise<T>, maxRetries: number = 3): Promise<T> {
    let lastError: Error = new Error('Unknown error');

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error as Error;

        // Check if it's a rate limit error (403 or 429)
        const err = error as {
          status?: number;
          response?: { status?: number; headers?: Record<string, string> };
          headers?: Record<string, string>;
        };
        const status = err.status || err.response?.status;
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
          err.response?.headers?.['x-ratelimit-reset'] || err.headers?.['x-ratelimit-reset'];

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

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Create a new GitHub Gist with multiple files, under the given user's
   * own GitHub account.
   */
  async createGist(
    githubToken: string,
    files: DeploymentFile[],
    description: string,
    isPublic: boolean = true,
  ): Promise<GistResult> {
    try {
      const octokit = this.buildOctokit(githubToken);

      // Convert files array to Gist files format
      const gistFiles: Record<string, { content: string }> = {};

      for (const file of files) {
        // Gist doesn't support directories, so flatten the path
        const fileName = file.path.replace(/\//g, '_');
        gistFiles[fileName] = { content: file.content };
      }

      const { data } = await this.withRateLimitRetry(() =>
        octokit.rest.gists.create({
          description,
          public: isPublic,
          files: gistFiles,
        }),
      );

      // Extract raw URL from the first file
      const firstFile = data.files ? Object.values(data.files)[0] : null;
      const rawUrl = firstFile?.raw_url;

      this.logger.log(`Created Gist: ${data.id}`);

      return {
        success: true,
        gistUrl: data.html_url,
        gistId: data.id,
        rawUrl,
      };
    } catch (error) {
      const err = error as Error;
      this.logger.error(`Failed to create Gist: ${err.message}`);
      return {
        success: false,
        error: err.message,
      };
    }
  }

  /**
   * Create a single-file Gist with bundled MCP server code, under the given
   * user's own GitHub account. This is the primary method for free tier
   * deployments.
   */
  async createSingleFileGist(
    githubToken: string,
    files: DeploymentFile[],
    options: SingleFileGistOptions,
  ): Promise<GistResult> {
    try {
      const octokit = this.buildOctokit(githubToken);

      // Bundle all files into a single TypeScript file
      const bundledCode = this.bundleServerCode(files, options);

      // Generate comprehensive README description
      const comprehensiveDescription = this.generateComprehensiveDescription(options);

      // Create the filename based on server name
      const fileName = `${this.sanitizeFileName(options.serverName)}.ts`;

      const { data } = await this.withRateLimitRetry(() =>
        octokit.rest.gists.create({
          description: comprehensiveDescription,
          public: options.isPublic ?? true,
          files: {
            [fileName]: { content: bundledCode },
          },
        }),
      );

      // Extract raw URL for direct download
      const gistFile = data.files?.[fileName];
      const rawUrl = gistFile?.raw_url;

      this.logger.log(`Created single-file Gist: ${data.id} with raw URL: ${rawUrl}`);

      return {
        success: true,
        gistUrl: data.html_url,
        gistId: data.id,
        rawUrl,
      };
    } catch (error) {
      const err = error as Error;
      this.logger.error(`Failed to create single-file Gist: ${err.message}`);
      return {
        success: false,
        error: err.message,
      };
    }
  }

  /**
   * Bundle multiple server files into a single TypeScript file
   */
  private bundleServerCode(files: DeploymentFile[], options: SingleFileGistOptions): string {
    // Find the main server file (usually src/index.ts or index.ts)
    const mainFile = files.find((f) => f.path === 'src/index.ts' || f.path === 'index.ts');

    // Find package.json to extract dependencies
    const packageJsonFile = files.find((f) => f.path === 'package.json');
    let dependencies: Record<string, string> = {};

    if (packageJsonFile) {
      try {
        const pkg = JSON.parse(packageJsonFile.content);
        dependencies = pkg.dependencies || {};
      } catch {
        // Ignore parse errors
      }
    }

    // Build the bundled file with header comments
    const header = this.generateFileHeader(options, dependencies);

    // Use the main file content, or combine all TypeScript files
    let serverCode: string;
    if (mainFile) {
      serverCode = mainFile.content;
    } else {
      // Fallback: concatenate all .ts files
      serverCode = files
        .filter((f) => f.path.endsWith('.ts'))
        .map((f) => `// === ${f.path} ===\n${f.content}`)
        .join('\n\n');
    }

    return `${header}\n\n${serverCode}`;
  }

  /**
   * Generate file header with usage instructions and dependencies
   */
  private generateFileHeader(
    options: SingleFileGistOptions,
    dependencies: Record<string, string>,
  ): string {
    const depsComment = Object.entries(dependencies)
      .map(([name, version]) => ` *   ${name}: ${version}`)
      .join('\n');

    const toolsList = options.tools.map((t) => ` *   - ${t.name}: ${t.description}`).join('\n');

    return `/**
 * ${options.serverName}
 * ${options.description}
 *
 * Generated by MCP Everything - https://github.com/4eyedengineer/mcp-everything
 *
 * === QUICK START ===
 *
 * 1. Save this file locally:
 *    curl -o ${this.sanitizeFileName(options.serverName)}.ts "<RAW_URL>"
 *
 * 2. Install dependencies:
 *    npm install ${Object.keys(dependencies).join(' ')}
 *
 * 3. Run the server:
 *    npx ts-node ${this.sanitizeFileName(options.serverName)}.ts
 *
 * === DEPENDENCIES ===
${depsComment || ' *   (none)'}
 *
 * === AVAILABLE TOOLS ===
${toolsList || ' *   (none defined)'}
 *
 * === LICENSE ===
 * MIT License - Feel free to modify and distribute
 */`;
  }

  /**
   * Generate comprehensive description for the Gist
   */
  private generateComprehensiveDescription(options: SingleFileGistOptions): string {
    const toolNames = options.tools.map((t) => t.name).join(', ');

    // Gist descriptions have a limit, so we keep it informative but concise
    const parts = [
      `🔧 MCP Server: ${options.serverName}`,
      options.description,
      `Tools: ${toolNames || 'none'}`,
      `📦 Run: npx ts-node <filename>`,
      `Generated by MCP Everything`,
    ];

    return parts.filter(Boolean).join(' | ');
  }

  /**
   * Sanitize a name for use as a filename
   */
  private sanitizeFileName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  /**
   * Update an existing GitHub Gist. `githubToken` must be the owning user's
   * own token - only the Gist's owner (or a collaborator) can update it.
   */
  async updateGist(
    githubToken: string,
    gistId: string,
    files: DeploymentFile[],
    description?: string,
  ): Promise<GistResult> {
    try {
      const octokit = this.buildOctokit(githubToken);

      // Convert files array to Gist files format
      const gistFiles: Record<string, { content: string }> = {};

      for (const file of files) {
        const fileName = file.path.replace(/\//g, '_');
        gistFiles[fileName] = { content: file.content };
      }

      const updateData: {
        gist_id: string;
        files: Record<string, { content: string }>;
        description?: string;
      } = {
        gist_id: gistId,
        files: gistFiles,
      };

      if (description) {
        updateData.description = description;
      }

      const { data } = await this.withRateLimitRetry(() => octokit.rest.gists.update(updateData));

      // Extract raw URL from the first file
      const firstFile = data.files ? Object.values(data.files)[0] : null;
      const rawUrl = firstFile?.raw_url;

      this.logger.log(`Updated Gist: ${data.id}`);

      return {
        success: true,
        gistUrl: data.html_url,
        gistId: data.id,
        rawUrl,
      };
    } catch (error) {
      const err = error as Error;
      this.logger.error(`Failed to update Gist: ${err.message}`);
      return {
        success: false,
        error: err.message,
      };
    }
  }

  /**
   * Get a Gist by ID
   */
  async getGist(githubToken: string, gistId: string): Promise<GistResult> {
    try {
      const octokit = this.buildOctokit(githubToken);
      const { data } = await this.withRateLimitRetry(() =>
        octokit.rest.gists.get({ gist_id: gistId }),
      );

      // Extract raw URL from the first file
      const firstFile = data.files ? Object.values(data.files)[0] : null;
      const rawUrl = firstFile?.raw_url;

      return {
        success: true,
        gistUrl: data.html_url,
        gistId: data.id,
        rawUrl,
      };
    } catch (error) {
      const err = error as Error;
      this.logger.error(`Failed to get Gist: ${err.message}`);
      return {
        success: false,
        error: err.message,
      };
    }
  }

  /**
   * Delete a Gist. `githubToken` must be the owning user's own token - only
   * the Gist's owner (or a collaborator) can delete it.
   */
  async deleteGist(githubToken: string, gistId: string): Promise<boolean> {
    try {
      const octokit = this.buildOctokit(githubToken);
      await this.withRateLimitRetry(() => octokit.rest.gists.delete({ gist_id: gistId }));
      this.logger.log(`Deleted Gist: ${gistId}`);
      return true;
    } catch (error) {
      const err = error as Error;
      this.logger.error(`Failed to delete Gist: ${err.message}`);
      return false;
    }
  }

  /**
   * Deploy files to a new Gist (legacy multi-file method)
   * @deprecated Use deploySingleFile for free tier deployments
   */
  async deploy(
    githubToken: string,
    serverName: string,
    files: DeploymentFile[],
    description: string,
    isPublic: boolean = true,
  ): Promise<GistResult> {
    const gistDescription = `MCP Server: ${serverName} - ${description}`;
    return this.createGist(githubToken, files, gistDescription, isPublic);
  }

  /**
   * Deploy files as a single bundled file to a new Gist, under the given
   * user's own GitHub account. Primary method for free tier deployments.
   */
  async deploySingleFile(
    githubToken: string,
    serverName: string,
    files: DeploymentFile[],
    description: string,
    tools: McpToolInfo[],
    isPublic: boolean = true,
  ): Promise<GistResult> {
    return this.createSingleFileGist(githubToken, files, {
      serverName,
      description,
      tools,
      isPublic,
    });
  }
}
