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
import { HostingService } from './hosting.service';
import { DeployServerDto } from './dto/deploy-server.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../database/entities/user.entity';

@Controller('api/hosting')
export class HostingController {
  private readonly logger = new Logger(HostingController.name);

  constructor(private readonly hostingService: HostingService) {}

  /**
   * Deploy a generated MCP server to Kubernetes
   */
  @Post('deploy/:conversationId')
  async deployServer(
    @Param('conversationId') conversationId: string,
    @Body() dto: DeployServerDto,
  ) {
    try {
      this.logger.log(`Deploying server for conversation: ${conversationId}`);

      const result = await this.hostingService.deployToCloud(conversationId);

      return {
        success: result.success,
        serverId: result.serverId,
        endpointUrl: result.endpointUrl,
        status: result.status,
        error: result.error,
      };
    } catch (error) {
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
    // User is authenticated via global JWT guard
    const servers = await this.hostingService.getServers();

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
  async getServer(@Param('serverId') serverId: string) {
    const server = await this.hostingService.getServer(serverId);

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
   * Get real-time deployment status
   */
  @Get('servers/:serverId/status')
  async getServerStatus(@Param('serverId') serverId: string) {
    const server = await this.hostingService.getServer(serverId);

    // Derive replica counts based on status
    const replicas = server.status === 'stopped' ? 0 : 1;
    const readyReplicas =
      server.status === 'running' ? 1 : server.status === 'stopped' ? 0 : 0;

    return {
      serverId: server.serverId,
      status: server.status,
      message: server.statusMessage || '',
      replicas,
      readyReplicas,
      lastUpdated: server.lastStatusChange || server.updatedAt,
    };
  }

  /**
   * Get server logs (last N lines)
   */
  @Get('servers/:serverId/logs')
  async getServerLogs(
    @Param('serverId') serverId: string,
    @Query('lines') lines: number = 100,
    @Query('since') since?: string,
  ) {
    const logs = await this.hostingService.getServerLogs(serverId, {
      lines,
      since,
    });

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
  async stopServer(@Param('serverId') serverId: string) {
    try {
      await this.hostingService.stopServer(serverId);

      return {
        success: true,
        message: 'Server stopped successfully',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new HttpException(message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  /**
   * Start a stopped server (scale to 1)
   */
  @Post('servers/:serverId/start')
  async startServer(@Param('serverId') serverId: string) {
    try {
      await this.hostingService.startServer(serverId);

      return {
        success: true,
        message: 'Server started successfully',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new HttpException(message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  /**
   * Delete a hosted server permanently
   */
  @Delete('servers/:serverId')
  async deleteServer(@Param('serverId') serverId: string) {
    try {
      await this.hostingService.deleteServer(serverId);

      return {
        success: true,
        message: 'Server deleted successfully',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new HttpException(message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}
