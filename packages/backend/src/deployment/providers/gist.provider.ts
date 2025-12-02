import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Octokit } from '@octokit/rest';
import { GistResult, DeploymentFile } from '../types/deployment.types';

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
   * Create a new GitHub Gist
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

      this.logger.log(`Created Gist: ${data.id}`);

      return {
        success: true,
        gistUrl: data.html_url,
        gistId: data.id,
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

      this.logger.log(`Updated Gist: ${data.id}`);

      return {
        success: true,
        gistUrl: data.html_url,
        gistId: data.id,
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

      return {
        success: true,
        gistUrl: data.html_url,
        gistId: data.id,
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
   * Deploy files to a new Gist
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
}
