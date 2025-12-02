import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  UseGuards,
} from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { DeploymentOrchestratorService } from './deployment.service';
import {
  DeployToGitHubDto,
  DeployToGistDto,
  DeployToEnterpriseDto,
  DeploymentResponseDto,
  DeploymentStatusDto,
  UpdateGistDto,
  ListDeploymentsQueryDto,
  PaginatedDeploymentsDto,
} from './dto/deploy-request.dto';
import { DeploymentType, DeploymentStatus } from './types/deployment.types';

// TODO: Uncomment when authentication is implemented
// import { AuthGuard } from '@nestjs/passport';

/**
 * Deployment API Controller
 *
 * Rate limited to 10 requests per minute per IP address.
 * Authentication will be required when implemented.
 */
// TODO: Add authentication when implemented
// @UseGuards(AuthGuard('jwt'))
@Controller('api/deploy')
@UseGuards(ThrottlerGuard)
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

  /**
   * List all deployments with filtering and pagination
   */
  @Get()
  async listDeployments(
    @Query() query: ListDeploymentsQueryDto,
  ): Promise<PaginatedDeploymentsDto> {
    this.logger.log(`Listing deployments with filters: ${JSON.stringify(query)}`);

    const result = await this.deploymentService.listDeployments({
      type: query.type as DeploymentType | undefined,
      status: query.status as DeploymentStatus | undefined,
      limit: query.limit,
      offset: query.offset,
    });

    return {
      deployments: result.deployments.map((d) => ({
        deploymentId: d.deploymentId,
        conversationId: d.conversationId,
        type: d.type,
        status: d.status,
        urls: d.urls,
        errorMessage: d.errorMessage,
        createdAt: d.createdAt,
        deployedAt: d.deployedAt,
      })),
      total: result.total,
      limit: result.limit,
      offset: result.offset,
    };
  }

  /**
   * Get a single deployment by ID
   */
  @Get('id/:deploymentId')
  async getDeploymentById(
    @Param('deploymentId') deploymentId: string,
  ): Promise<DeploymentStatusDto> {
    this.logger.log(`Getting deployment: ${deploymentId}`);

    const deployment = await this.deploymentService.getDeploymentById(deploymentId);

    if (!deployment) {
      throw new NotFoundException(`Deployment not found: ${deploymentId}`);
    }

    return {
      deploymentId: deployment.deploymentId,
      conversationId: deployment.conversationId,
      type: deployment.type,
      status: deployment.status,
      urls: deployment.urls,
      errorMessage: deployment.errorMessage,
      createdAt: deployment.createdAt,
      deployedAt: deployment.deployedAt,
    };
  }

  /**
   * Update a Gist deployment
   */
  @Patch('gist/:deploymentId')
  @HttpCode(HttpStatus.OK)
  async updateGistDeployment(
    @Param('deploymentId') deploymentId: string,
    @Body() dto: UpdateGistDto,
  ): Promise<DeploymentResponseDto> {
    this.logger.log(`Update Gist deployment: ${deploymentId}`);

    try {
      const result = await this.deploymentService.updateGistDeployment(
        deploymentId,
        dto.description,
      );

      return {
        success: result.success,
        deploymentId: result.deploymentId,
        type: result.type,
        urls: result.urls,
        error: result.error,
      };
    } catch (error) {
      this.logger.error(`Update Gist failed: ${error.message}`);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Delete a Gist deployment
   */
  @Delete('gist/:deploymentId')
  @HttpCode(HttpStatus.OK)
  async deleteGistDeployment(
    @Param('deploymentId') deploymentId: string,
  ): Promise<{ success: boolean; error?: string }> {
    this.logger.log(`Delete Gist deployment: ${deploymentId}`);

    try {
      return await this.deploymentService.deleteGistDeployment(deploymentId);
    } catch (error) {
      this.logger.error(`Delete Gist failed: ${error.message}`);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Delete a repository deployment
   */
  @Delete('repo/:deploymentId')
  @HttpCode(HttpStatus.OK)
  async deleteRepoDeployment(
    @Param('deploymentId') deploymentId: string,
  ): Promise<{ success: boolean; error?: string }> {
    this.logger.log(`Delete repository deployment: ${deploymentId}`);

    try {
      return await this.deploymentService.deleteRepoDeployment(deploymentId);
    } catch (error) {
      this.logger.error(`Delete repository failed: ${error.message}`);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Deploy to enterprise (stub - not yet implemented)
   */
  @Post('enterprise')
  @HttpCode(HttpStatus.OK)
  async deployToEnterprise(
    @Body() dto: DeployToEnterpriseDto,
  ): Promise<DeploymentResponseDto> {
    this.logger.log(`Enterprise deployment request for conversation: ${dto.conversationId}`);

    try {
      const result = await this.deploymentService.deployToEnterprise(
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
      this.logger.error(`Enterprise deployment failed: ${error.message}`);
      return {
        success: false,
        error: error.message,
      };
    }
  }
}
