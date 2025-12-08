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
  Req,
  ForbiddenException,
} from '@nestjs/common';
import { Request } from 'express';
import { ThrottlerGuard } from '@nestjs/throttler';
import { DeploymentOrchestratorService } from './deployment.service';
import { DeploymentRouterService, TierRestrictedDeploymentOptions } from './services/deployment-router.service';
import {
  DeployToGitHubDto,
  DeployToGistDto,
  DeployToEnterpriseDto,
  DeploymentResponseDto,
  DeploymentStatusDto,
  UpdateGistDto,
  ListDeploymentsQueryDto,
  PaginatedDeploymentsDto,
  RetryDeploymentDto,
} from './dto/deploy-request.dto';
import { DeploymentType, DeploymentStatus } from './types/deployment.types';
import { DeploymentRetryService } from './services/retry.service';
import { DeploymentErrorCode } from './types/deployment-errors.types';
import { User } from '../database/entities/user.entity';

// TODO: Uncomment when authentication is implemented
// import { AuthGuard } from '@nestjs/passport';

// Helper to get current user from request
function getCurrentUser(req: Request): User | null {
  return (req as any).user || null;
}

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
    private readonly retryService: DeploymentRetryService,
    private readonly routerService: DeploymentRouterService,
  ) {}

  /**
   * Deploy generated MCP server to a GitHub repository
   * Enforces tier-based usage limits when user is authenticated
   */
  @Post('github')
  @HttpCode(HttpStatus.OK)
  async deployToGitHub(
    @Req() req: Request,
    @Body() dto: DeployToGitHubDto,
  ): Promise<DeploymentResponseDto> {
    this.logger.log(`Deploy to GitHub request for conversation: ${dto.conversationId}`);

    try {
      const user = getCurrentUser(req);

      // If user is authenticated, route through tier-based system
      if (user) {
        const routerOptions: TierRestrictedDeploymentOptions = {
          ...dto.options,
          deploymentType: 'repo',
        };

        const result = await this.routerService.routeDeployment(
          user.id,
          dto.conversationId,
          routerOptions,
        );

        return {
          success: result.success,
          deploymentId: result.deploymentId,
          type: result.type,
          urls: result.urls,
          error: result.error,
          errorCode: result.errorCode,
          retryStrategy: result.retryStrategy,
          retryAfterMs: result.retryAfterMs,
          suggestedNames: result.suggestedNames,
          canRetry: result.errorCode
            ? this.retryService.canRetry(result.errorCode)
            : undefined,
        };
      }

      // Fallback for unauthenticated requests (development/testing)
      // TODO: Remove this fallback once authentication is fully implemented
      this.logger.warn('Unauthenticated deployment request - bypassing usage limits');
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
        errorCode: result.errorCode,
        retryStrategy: result.retryStrategy,
        retryAfterMs: result.retryAfterMs,
        suggestedNames: result.suggestedNames,
        canRetry: result.errorCode
          ? this.retryService.canRetry(result.errorCode)
          : undefined,
      };
    } catch (error) {
      // Handle ForbiddenException from router (tier/limit errors)
      if (error instanceof ForbiddenException) {
        const errorBody = error.getResponse() as any;
        this.logger.warn(`Deployment blocked: ${errorBody.message}`);
        return {
          success: false,
          error: errorBody.message,
          errorCode: errorBody.code,
          currentUsage: errorBody.currentUsage,
          limit: errorBody.limit,
          currentTier: errorBody.currentTier,
          requiredTier: errorBody.requiredTier,
          upgradeUrl: errorBody.upgradeUrl,
        };
      }

      const err = error as Error;
      this.logger.error(`GitHub deployment failed: ${err.message}`);
      return {
        success: false,
        error: err.message,
      };
    }
  }

  /**
   * Deploy generated MCP server to a GitHub Gist
   * Enforces tier-based usage limits when user is authenticated
   */
  @Post('gist')
  @HttpCode(HttpStatus.OK)
  async deployToGist(
    @Req() req: Request,
    @Body() dto: DeployToGistDto,
  ): Promise<DeploymentResponseDto> {
    this.logger.log(`Deploy to Gist request for conversation: ${dto.conversationId}`);

    try {
      const user = getCurrentUser(req);

      // If user is authenticated, route through tier-based system
      if (user) {
        const routerOptions: TierRestrictedDeploymentOptions = {
          ...dto.options,
          deploymentType: 'gist',
        };

        const result = await this.routerService.routeDeployment(
          user.id,
          dto.conversationId,
          routerOptions,
        );

        return {
          success: result.success,
          deploymentId: result.deploymentId,
          type: result.type,
          urls: result.urls,
          error: result.error,
          errorCode: result.errorCode,
          retryStrategy: result.retryStrategy,
          retryAfterMs: result.retryAfterMs,
          suggestedNames: result.suggestedNames,
          canRetry: result.errorCode
            ? this.retryService.canRetry(result.errorCode)
            : undefined,
        };
      }

      // Fallback for unauthenticated requests (development/testing)
      // TODO: Remove this fallback once authentication is fully implemented
      this.logger.warn('Unauthenticated deployment request - bypassing usage limits');
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
        errorCode: result.errorCode,
        retryStrategy: result.retryStrategy,
        retryAfterMs: result.retryAfterMs,
        suggestedNames: result.suggestedNames,
        canRetry: result.errorCode
          ? this.retryService.canRetry(result.errorCode)
          : undefined,
      };
    } catch (error) {
      // Handle ForbiddenException from router (tier/limit errors)
      if (error instanceof ForbiddenException) {
        const errorBody = error.getResponse() as any;
        this.logger.warn(`Deployment blocked: ${errorBody.message}`);
        return {
          success: false,
          error: errorBody.message,
          errorCode: errorBody.code,
          currentUsage: errorBody.currentUsage,
          limit: errorBody.limit,
          currentTier: errorBody.currentTier,
          requiredTier: errorBody.requiredTier,
          upgradeUrl: errorBody.upgradeUrl,
        };
      }

      const err = error as Error;
      this.logger.error(`Gist deployment failed: ${err.message}`);
      return {
        success: false,
        error: err.message,
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
   * Retry a failed deployment by conversation ID
   */
  @Post(':conversationId/retry')
  @HttpCode(HttpStatus.OK)
  async retryDeploymentByConversation(
    @Param('conversationId') conversationId: string,
    @Body() dto?: RetryDeploymentDto,
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
        dto?.newServerName,
        dto?.forceRetry,
      );

      return {
        success: result.success,
        deploymentId: result.deploymentId,
        type: result.type,
        urls: result.urls,
        error: result.error,
        errorCode: result.errorCode,
        retryStrategy: result.retryStrategy,
        suggestedNames: result.suggestedNames,
        canRetry: result.errorCode
          ? this.retryService.canRetry(result.errorCode)
          : undefined,
      };
    } catch (error) {
      const err = error as Error;
      this.logger.error(`Retry deployment failed: ${err.message}`);
      return {
        success: false,
        error: err.message,
      };
    }
  }

  /**
   * Retry a failed deployment by deployment ID
   */
  @Post('retry/:deploymentId')
  @HttpCode(HttpStatus.OK)
  async retryDeploymentById(
    @Param('deploymentId') deploymentId: string,
    @Body() dto?: RetryDeploymentDto,
  ): Promise<DeploymentResponseDto> {
    this.logger.log(`Retry deployment by ID: ${deploymentId}`);

    try {
      const result = await this.deploymentService.retryDeployment(
        deploymentId,
        dto?.newServerName,
        dto?.forceRetry,
      );

      return {
        success: result.success,
        deploymentId: result.deploymentId,
        type: result.type,
        urls: result.urls,
        error: result.error,
        errorCode: result.errorCode,
        retryStrategy: result.retryStrategy,
        suggestedNames: result.suggestedNames,
        canRetry: result.errorCode
          ? this.retryService.canRetry(result.errorCode)
          : undefined,
      };
    } catch (error) {
      const err = error as Error;
      this.logger.error(`Retry deployment failed: ${err.message}`);
      return {
        success: false,
        error: err.message,
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
