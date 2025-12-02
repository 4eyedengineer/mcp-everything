import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Octokit } from '@octokit/rest';
import { GistResult, DeploymentFile } from '../types/deployment.types';

export interface McpToolInfo {
  name: string;
  description: string;
}

export interface SingleFileGistOptions {
  serverName: string;
  description: string;
  tools: McpToolInfo[];
  isPublic?: boolean;
}

@Injectable()
export class GistProvider {
  private readonly logger = new Logger(GistProvider.name);
  private octokit: Octokit;

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
   * Create a new GitHub Gist with multiple files
   */
  async createGist(
    files: DeploymentFile[],
    description: string,
    isPublic: boolean = true,
  ): Promise<GistResult> {
    try {
      // Convert files array to Gist files format
      const gistFiles: Record<string, { content: string }> = {};

      for (const file of files) {
        // Gist doesn't support directories, so flatten the path
        const fileName = file.path.replace(/\//g, '_');
        gistFiles[fileName] = { content: file.content };
      }

      const { data } = await this.octokit.rest.gists.create({
        description,
        public: isPublic,
        files: gistFiles,
      });

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
      this.logger.error(`Failed to create Gist: ${error.message}`);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Create a single-file Gist with bundled MCP server code
   * This is the primary method for free tier deployments
   */
  async createSingleFileGist(
    files: DeploymentFile[],
    options: SingleFileGistOptions,
  ): Promise<GistResult> {
    try {
      // Bundle all files into a single TypeScript file
      const bundledCode = this.bundleServerCode(files, options);

      // Generate comprehensive README description
      const comprehensiveDescription = this.generateComprehensiveDescription(options);

      // Create the filename based on server name
      const fileName = `${this.sanitizeFileName(options.serverName)}.ts`;

      const { data } = await this.octokit.rest.gists.create({
        description: comprehensiveDescription,
        public: options.isPublic ?? true,
        files: {
          [fileName]: { content: bundledCode },
        },
      });

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
      this.logger.error(`Failed to create single-file Gist: ${error.message}`);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Bundle multiple server files into a single TypeScript file
   */
  private bundleServerCode(files: DeploymentFile[], options: SingleFileGistOptions): string {
    // Find the main server file (usually src/index.ts or index.ts)
    const mainFile = files.find(
      (f) => f.path === 'src/index.ts' || f.path === 'index.ts',
    );

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

    const toolsList = options.tools
      .map((t) => ` *   - ${t.name}: ${t.description}`)
      .join('\n');

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
   * Update an existing GitHub Gist
   */
  async updateGist(
    gistId: string,
    files: DeploymentFile[],
    description?: string,
  ): Promise<GistResult> {
    try {
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

      const { data } = await this.octokit.rest.gists.update(updateData);

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
      this.logger.error(`Failed to update Gist: ${error.message}`);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Get a Gist by ID
   */
  async getGist(gistId: string): Promise<GistResult> {
    try {
      const { data } = await this.octokit.rest.gists.get({ gist_id: gistId });

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
      this.logger.error(`Failed to get Gist: ${error.message}`);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Delete a Gist
   */
  async deleteGist(gistId: string): Promise<boolean> {
    try {
      await this.octokit.rest.gists.delete({ gist_id: gistId });
      this.logger.log(`Deleted Gist: ${gistId}`);
      return true;
    } catch (error) {
      this.logger.error(`Failed to delete Gist: ${error.message}`);
      return false;
    }
  }

  /**
   * Deploy files to a new Gist (legacy multi-file method)
   * @deprecated Use deploySingleFile for free tier deployments
   */
  async deploy(
    serverName: string,
    files: DeploymentFile[],
    description: string,
    isPublic: boolean = true,
  ): Promise<GistResult> {
    const gistDescription = `MCP Server: ${serverName} - ${description}`;
    return this.createGist(files, gistDescription, isPublic);
  }

  /**
   * Deploy files as a single bundled file to a new Gist
   * Primary method for free tier deployments
   */
  async deploySingleFile(
    serverName: string,
    files: DeploymentFile[],
    description: string,
    tools: McpToolInfo[],
    isPublic: boolean = true,
  ): Promise<GistResult> {
    return this.createSingleFileGist(files, {
      serverName,
      description,
      tools,
      isPublic,
    });
  }
}
