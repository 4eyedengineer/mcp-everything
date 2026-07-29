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
  ForbiddenException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { DeploymentOrchestratorService } from './deployment.service';
import {
  DeploymentRouterService,
  TierRestrictedDeploymentOptions,
} from './services/deployment-router.service';
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
import { User } from '../database/entities/user.entity';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

/**
 * Deployment API Controller
 *
 * Rate limited to 10 requests per minute per IP address (enforced by the
 * global ThrottlerGuard using this class-level override).
 * All routes require authentication (handled by global JWT guard) and every
 * resource lookup is scoped to the authenticated user.
 */
@Controller('api/deploy')
@Throttle({ default: { limit: 10, ttl: 60000 } })
export class DeploymentController {
  private readonly logger = new Logger(DeploymentController.name);

  constructor(
    private readonly deploymentService: DeploymentOrchestratorService,
    private readonly retryService: DeploymentRetryService,
    private readonly routerService: DeploymentRouterService,
  ) {}

  /**
   * Deploy generated MCP server to a GitHub repository
   * Enforces tier-based usage limits for the authenticated user
   */
  @Post('github')
  @HttpCode(HttpStatus.OK)
  async deployToGitHub(
    @CurrentUser() user: User,
    @Body() dto: DeployToGitHubDto,
  ): Promise<DeploymentResponseDto> {
    this.logger.log(`Deploy to GitHub request for conversation: ${dto.conversationId}`);

    try {
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
        errorCause: result.errorCause,
        errorCode: result.errorCode,
        retryStrategy: result.retryStrategy,
        retryAfterMs: result.retryAfterMs,
        suggestedNames: result.suggestedNames,
        canRetry: result.errorCode ? this.retryService.canRetry(result.errorCode) : undefined,
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
   * Enforces tier-based usage limits for the authenticated user
   */
  @Post('gist')
  @HttpCode(HttpStatus.OK)
  async deployToGist(
    @CurrentUser() user: User,
    @Body() dto: DeployToGistDto,
  ): Promise<DeploymentResponseDto> {
    this.logger.log(`Deploy to Gist request for conversation: ${dto.conversationId}`);

    try {
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
        errorCause: result.errorCause,
        errorCode: result.errorCode,
        retryStrategy: result.retryStrategy,
        retryAfterMs: result.retryAfterMs,
        suggestedNames: result.suggestedNames,
        canRetry: result.errorCode ? this.retryService.canRetry(result.errorCode) : undefined,
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
    @CurrentUser() user: User,
    @Param('conversationId') conversationId: string,
  ): Promise<{ deployments: DeploymentStatusDto[] }> {
    this.logger.log(`Getting deployment status for conversation: ${conversationId}`);

    const deployments = await this.deploymentService.getDeploymentStatus(conversationId, user.id);

    return { deployments };
  }

  /**
   * Retry a failed deployment by conversation ID
   */
  @Post(':conversationId/retry')
  @HttpCode(HttpStatus.OK)
  async retryDeploymentByConversation(
    @CurrentUser() user: User,
    @Param('conversationId') conversationId: string,
    @Body() dto?: RetryDeploymentDto,
  ): Promise<DeploymentResponseDto> {
    this.logger.log(`Retry deployment request for conversation: ${conversationId}`);

    try {
      // Get the latest deployment for this conversation (owned by this user)
      const latestDeployment = await this.deploymentService.getLatestDeployment(
        conversationId,
        user.id,
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
        user.id,
      );

      return {
        success: result.success,
        deploymentId: result.deploymentId,
        type: result.type,
        urls: result.urls,
        error: result.error,
        errorCause: result.errorCause,
        errorCode: result.errorCode,
        retryStrategy: result.retryStrategy,
        suggestedNames: result.suggestedNames,
        canRetry: result.errorCode ? this.retryService.canRetry(result.errorCode) : undefined,
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
    @CurrentUser() user: User,
    @Param('deploymentId') deploymentId: string,
    @Body() dto?: RetryDeploymentDto,
  ): Promise<DeploymentResponseDto> {
    this.logger.log(`Retry deployment by ID: ${deploymentId}`);

    try {
      const result = await this.deploymentService.retryDeployment(
        deploymentId,
        dto?.newServerName,
        dto?.forceRetry,
        user.id,
      );

      return {
        success: result.success,
        deploymentId: result.deploymentId,
        type: result.type,
        urls: result.urls,
        error: result.error,
        errorCause: result.errorCause,
        errorCode: result.errorCode,
        retryStrategy: result.retryStrategy,
        suggestedNames: result.suggestedNames,
        canRetry: result.errorCode ? this.retryService.canRetry(result.errorCode) : undefined,
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
    @CurrentUser() user: User,
    @Query() query: ListDeploymentsQueryDto,
  ): Promise<PaginatedDeploymentsDto> {
    this.logger.log(`Listing deployments with filters: ${JSON.stringify(query)}`);

    const result = await this.deploymentService.listDeployments({
      type: query.type as DeploymentType | undefined,
      status: query.status as DeploymentStatus | undefined,
      limit: query.limit,
      offset: query.offset,
      // Never list other users' deployments
      userId: user.id,
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
    @CurrentUser() user: User,
    @Param('deploymentId') deploymentId: string,
  ): Promise<DeploymentStatusDto> {
    this.logger.log(`Getting deployment: ${deploymentId}`);

    const deployment = await this.deploymentService.getDeploymentById(deploymentId, user.id);

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
    @CurrentUser() user: User,
    @Param('deploymentId') deploymentId: string,
    @Body() dto: UpdateGistDto,
  ): Promise<DeploymentResponseDto> {
    this.logger.log(`Update Gist deployment: ${deploymentId}`);

    try {
      const result = await this.deploymentService.updateGistDeployment(
        deploymentId,
        dto.description,
        user.id,
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
    @CurrentUser() user: User,
    @Param('deploymentId') deploymentId: string,
  ): Promise<{ success: boolean; error?: string }> {
    this.logger.log(`Delete Gist deployment: ${deploymentId}`);

    try {
      return await this.deploymentService.deleteGistDeployment(deploymentId, user.id);
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
    @CurrentUser() user: User,
    @Param('deploymentId') deploymentId: string,
  ): Promise<{ success: boolean; error?: string }> {
    this.logger.log(`Delete repository deployment: ${deploymentId}`);

    try {
      return await this.deploymentService.deleteRepoDeployment(deploymentId, user.id);
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
  async deployToEnterprise(@Body() dto: DeployToEnterpriseDto): Promise<DeploymentResponseDto> {
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
