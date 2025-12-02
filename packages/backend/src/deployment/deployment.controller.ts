import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { DeploymentOrchestratorService } from './deployment.service';
import {
  DeployToGitHubDto,
  DeployToGistDto,
  DeploymentResponseDto,
  DeploymentStatusDto,
} from './dto/deploy-request.dto';

@Controller('api/deploy')
export class DeploymentController {
  private readonly logger = new Logger(DeploymentController.name);

  constructor(
    private readonly deploymentService: DeploymentOrchestratorService,
  ) {}

  /**
   * Deploy generated MCP server to a GitHub repository
   */
  @Post('github')
  @HttpCode(HttpStatus.OK)
  async deployToGitHub(
    @Body() dto: DeployToGitHubDto,
  ): Promise<DeploymentResponseDto> {
    this.logger.log(`Deploy to GitHub request for conversation: ${dto.conversationId}`);

    try {
      const result = await this.deploymentService.deployToGitHub(
        dto.conversationId,
        dto.options,
      );

      return {
        success: result.success,
        deploymentId: result.deploymentId,
        type: result.type,
        urls: result.urls,
        error: result.error,
      };
    } catch (error) {
      this.logger.error(`GitHub deployment failed: ${error.message}`);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Deploy generated MCP server to a GitHub Gist
   */
  @Post('gist')
  @HttpCode(HttpStatus.OK)
  async deployToGist(
    @Body() dto: DeployToGistDto,
  ): Promise<DeploymentResponseDto> {
    this.logger.log(`Deploy to Gist request for conversation: ${dto.conversationId}`);

    try {
      const result = await this.deploymentService.deployToGist(
        dto.conversationId,
        dto.options,
      );

      return {
        success: result.success,
        deploymentId: result.deploymentId,
        type: result.type,
        urls: result.urls,
        error: result.error,
      };
    } catch (error) {
      this.logger.error(`Gist deployment failed: ${error.message}`);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Get deployment status for a conversation
   */
  @Get(':conversationId/status')
  async getDeploymentStatus(
    @Param('conversationId') conversationId: string,
  ): Promise<{ deployments: DeploymentStatusDto[] }> {
    this.logger.log(`Getting deployment status for conversation: ${conversationId}`);

    const deployments = await this.deploymentService.getDeploymentStatus(
      conversationId,
    );

    return { deployments };
  }

  /**
   * Retry a failed deployment
   */
  @Post(':conversationId/retry')
  @HttpCode(HttpStatus.OK)
  async retryDeployment(
    @Param('conversationId') conversationId: string,
  ): Promise<DeploymentResponseDto> {
    this.logger.log(`Retry deployment request for conversation: ${conversationId}`);

    try {
      // Get the latest deployment for this conversation
      const latestDeployment = await this.deploymentService.getLatestDeployment(
        conversationId,
      );

      if (!latestDeployment) {
        return {
          success: false,
          error: 'No deployment found for this conversation',
        };
      }

      const result = await this.deploymentService.retryDeployment(
        latestDeployment.id,
      );

      return {
        success: result.success,
        deploymentId: result.deploymentId,
        type: result.type,
        urls: result.urls,
        error: result.error,
      };
    } catch (error) {
      this.logger.error(`Retry deployment failed: ${error.message}`);
      return {
        success: false,
        error: error.message,
      };
    }
  }
}
