import {
  Controller,
  Post,
  Get,
  Delete,
  Param,
  Query,
  Body,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { HostingService } from './hosting.service';
import { HostedServerApiKeyService } from './hosted-server-api-key.service';
import { DeployServerDto } from './dto/deploy-server.dto';
import {
  CreateHostedServerApiKeyDto,
  CreatedHostedServerApiKeyResponseDto,
  HostedServerApiKeyResponseDto,
} from './dto/hosted-server-api-key.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../database/entities/user.entity';

/**
 * Deploying a hosted server builds an image, pushes it and commits manifests -
 * minutes of work and real spend per call. 5/minute is generous for a human
 * clicking "Deploy" and tight enough that a runaway client loop is stopped
 * long before it can exhaust the concurrent-server cap or the build host.
 * The global default is 100/min (see ThrottlerModule.forRoot in app.module).
 */
const DEPLOY_RATE_LIMIT = { default: { limit: 5, ttl: 60_000 } };

/**
 * Key creation mints a credential and writes a row; a loop here is cheap for
 * the caller and noisy for us. MAX_ACTIVE_KEYS_PER_SERVER already bounds the
 * useful number of calls.
 */
const KEY_MUTATION_RATE_LIMIT = { default: { limit: 10, ttl: 60_000 } };

@Controller('api/hosting')
export class HostingController {
  private readonly logger = new Logger(HostingController.name);

  constructor(
    private readonly hostingService: HostingService,
    private readonly apiKeyService: HostedServerApiKeyService,
  ) {}

  /**
   * Deploy a generated MCP server to Kubernetes.
   *
   * Two limits apply: the @Throttle rate limit below (runaway loops) and the
   * per-tier concurrent hosted-server cap enforced in
   * HostingService.deployToCloud (403 HOSTED_SERVER_LIMIT_EXCEEDED).
   */
  @Throttle(DEPLOY_RATE_LIMIT)
  @Post('deploy/:conversationId')
  async deployServer(
    @CurrentUser() user: User,
    @Param('conversationId') conversationId: string,
    @Body() dto: DeployServerDto,
  ) {
    try {
      this.logger.log(`Deploying server for conversation: ${conversationId}`);

      const result = await this.hostingService.deployToCloud(
        conversationId,
        user.id,
        dto.envVars,
      );

      return {
        success: result.success,
        serverId: result.serverId,
        endpointUrl: result.endpointUrl,
        status: result.status,
        error: result.error,
      };
    } catch (error) {
      // Preserve 404/403 semantics (e.g. ownership checks) instead of masking as 500
      if (error instanceof HttpException) {
        throw error;
      }
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Deploy failed: ${message}`);
      throw new HttpException(message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  /**
   * List all hosted servers for the current user
   */
  @Get('servers')
  async listServers(
    @CurrentUser() user: User,
    @Query('status') status?: string,
    @Query('page') page: number = 1,
    @Query('limit') limit: number = 20,
  ) {
    // Only ever list servers owned by the authenticated user
    const servers = await this.hostingService.getServers(user.id);

    // Filter by status if provided
    let filteredServers = servers;
    if (status) {
      filteredServers = servers.filter((s) => s.status === status);
    }

    // Apply pagination
    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + limit;
    const paginatedServers = filteredServers.slice(startIndex, endIndex);

    return {
      servers: paginatedServers.map((server) => ({
        id: server.id,
        serverId: server.serverId,
        serverName: server.serverName,
        description: server.description,
        endpointUrl: server.endpointUrl,
        status: server.status,
        statusMessage: server.statusMessage,
        tools: server.tools,
        requestCount: server.requestCount,
        lastRequestAt: server.lastRequestAt,
        createdAt: server.createdAt,
        updatedAt: server.updatedAt,
        deployedAt: server.deployedAt,
      })),
      pagination: {
        page,
        limit,
        total: filteredServers.length,
        totalPages: Math.ceil(filteredServers.length / limit),
      },
    };
  }

  /**
   * Get details of a specific hosted server
   */
  @Get('servers/:serverId')
  async getServer(@CurrentUser() user: User, @Param('serverId') serverId: string) {
    const server = await this.hostingService.getServer(serverId, user.id);

    return {
      id: server.id,
      serverId: server.serverId,
      serverName: server.serverName,
      description: server.description,
      endpointUrl: server.endpointUrl,
      status: server.status,
      statusMessage: server.statusMessage,
      dockerImage: server.dockerImage,
      imageTag: server.imageTag,
      k8sNamespace: server.k8sNamespace,
      k8sDeploymentName: server.k8sDeploymentName,
      tools: server.tools,
      envVarNames: server.envVarNames,
      requestCount: server.requestCount,
      lastRequestAt: server.lastRequestAt,
      createdAt: server.createdAt,
      updatedAt: server.updatedAt,
      deployedAt: server.deployedAt,
      stoppedAt: server.stoppedAt,
    };
  }

  /**
   * Get deployment status.
   *
   * `replicas`/`readyReplicas` are REAL counts read from the Deployment by
   * K8sReconcilerService. They used to be invented from the status string
   * (`status === 'stopped' ? 0 : 1`), which meant they agreed with the status
   * by construction and could never reveal a disagreement - a pod in
   * CrashLoopBackOff reported 1/1.
   *
   * They are null until the reconciler's first pass over a newly deployed
   * server, and are reported as 0 in that window rather than guessed at.
   * `observedAt` tells the caller how fresh the numbers are (freshness is
   * bounded by K8S_RECONCILE_INTERVAL_MS, default 10s).
   */
  @Get('servers/:serverId/status')
  async getServerStatus(@CurrentUser() user: User, @Param('serverId') serverId: string) {
    const server = await this.hostingService.getServer(serverId, user.id);

    return {
      serverId: server.serverId,
      status: server.status,
      message: server.observedMessage || server.statusMessage || '',
      replicas: server.observedReplicas ?? 0,
      readyReplicas: server.observedReadyReplicas ?? 0,
      // The honest split behind the legacy `status` field above.
      desiredState: server.desiredState,
      observedStatus: server.observedStatus,
      observedAt: server.observedAt,
      lastUpdated: server.lastStatusChange || server.updatedAt,
    };
  }

  /**
   * Get server logs (last N lines)
   */
  @Get('servers/:serverId/logs')
  async getServerLogs(
    @CurrentUser() user: User,
    @Param('serverId') serverId: string,
    @Query('lines') lines: number = 100,
    @Query('since') since?: string,
  ) {
    const logs = await this.hostingService.getServerLogs(serverId, { lines, since }, user.id);

    return {
      serverId,
      logs: logs.logs,
      message: logs.message,
    };
  }

  /**
   * Stop a hosted server (scale to 0)
   */
  @Post('servers/:serverId/stop')
  async stopServer(@CurrentUser() user: User, @Param('serverId') serverId: string) {
    try {
      await this.hostingService.stopServer(serverId, user.id);

      return {
        success: true,
        message: 'Server stopped successfully',
      };
    } catch (error) {
      // Preserve 404/403 semantics (e.g. ownership checks) instead of masking as 500
      if (error instanceof HttpException) {
        throw error;
      }
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new HttpException(message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  /**
   * Start a stopped server (scale to 1)
   */
  @Post('servers/:serverId/start')
  async startServer(@CurrentUser() user: User, @Param('serverId') serverId: string) {
    try {
      await this.hostingService.startServer(serverId, user.id);

      return {
        success: true,
        message: 'Server started successfully',
      };
    } catch (error) {
      // Preserve 404/403 semantics (e.g. ownership checks) instead of masking as 500
      if (error instanceof HttpException) {
        throw error;
      }
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new HttpException(message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  // -------------------------------------------------------------------------
  // Per-server API key credentials
  //
  // These are enforced: McpGatewayController fronts every hosted MCP server and
  // HostedServerGatewayGuard verifies the key on each request. Revoking a key
  // here takes effect on the next request.
  // -------------------------------------------------------------------------

  /**
   * Create an API key for one of the caller's own hosted servers.
   *
   * The plaintext key is in the response body and will never be returned
   * again - only its SHA-256 hash is stored.
   */
  @Throttle(KEY_MUTATION_RATE_LIMIT)
  @Post('servers/:serverId/keys')
  async createServerApiKey(
    @CurrentUser() user: User,
    @Param('serverId') serverId: string,
    @Body() dto: CreateHostedServerApiKeyDto,
  ): Promise<CreatedHostedServerApiKeyResponseDto> {
    const created = await this.apiKeyService.createKey(serverId, user.id, {
      label: dto.label,
      expiresInDays: dto.expiresInDays,
    });

    return {
      key: created.plaintextKey,
      apiKey: created.key as HostedServerApiKeyResponseDto,
      warning: {
        shownOnce:
          'This is the only time this key will be shown. Store it now - it cannot be retrieved again.',
        usage:
          'Send this key as "Authorization: Bearer <key>" to the server\'s MCP gateway endpoint. ' +
          'It is verified on every request and stops working the moment it is revoked.',
      },
    };
  }

  /**
   * List API key metadata for one of the caller's own hosted servers.
   * Never returns the secret - it is not stored anywhere to return.
   */
  @Get('servers/:serverId/keys')
  async listServerApiKeys(
    @CurrentUser() user: User,
    @Param('serverId') serverId: string,
  ): Promise<{ apiKeys: HostedServerApiKeyResponseDto[] }> {
    const keys = await this.apiKeyService.listKeys(serverId, user.id);
    return { apiKeys: keys as HostedServerApiKeyResponseDto[] };
  }

  /**
   * Revoke an API key on one of the caller's own hosted servers.
   * A revoked key never verifies again; other keys on the server keep working,
   * which is what makes a zero-downtime rotation possible.
   */
  @Throttle(KEY_MUTATION_RATE_LIMIT)
  @Delete('servers/:serverId/keys/:keyId')
  async revokeServerApiKey(
    @CurrentUser() user: User,
    @Param('serverId') serverId: string,
    @Param('keyId') keyId: string,
  ): Promise<{ success: true; apiKey: HostedServerApiKeyResponseDto }> {
    const revoked = await this.apiKeyService.revokeKey(serverId, keyId, user.id);
    return { success: true, apiKey: revoked as HostedServerApiKeyResponseDto };
  }

  /**
   * Delete a hosted server permanently
   */
  @Delete('servers/:serverId')
  async deleteServer(@CurrentUser() user: User, @Param('serverId') serverId: string) {
    try {
      await this.hostingService.deleteServer(serverId, user.id);

      return {
        success: true,
        message: 'Server deleted successfully',
      };
    } catch (error) {
      // Preserve 404/403 semantics (e.g. ownership checks) instead of masking as 500
      if (error instanceof HttpException) {
        throw error;
      }
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new HttpException(message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}
