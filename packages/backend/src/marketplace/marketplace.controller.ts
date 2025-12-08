import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Req,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
  ParseUUIDPipe,
} from '@nestjs/common';
import { Request } from 'express';
import { MarketplaceService } from './marketplace.service';
import { CreateServerDto } from './dto/create-server.dto';
import { UpdateServerDto } from './dto/update-server.dto';
import { SearchServersDto, PaginatedResponse } from './dto/search-servers.dto';
import {
  ServerResponse,
  ServerSummaryResponse,
  CategoryResponse,
} from './dto/server-response.dto';
import { User } from '../database/entities/user.entity';

// TODO: Replace with proper auth guard once authentication is implemented
function getCurrentUser(req: Request): User | null {
  return (req as any).user || null;
}

function requireUser(req: Request): User {
  const user = getCurrentUser(req);
  if (!user) {
    throw new UnauthorizedException('Authentication required');
  }
  return user;
}

@Controller('api/v1/marketplace')
export class MarketplaceController {
  constructor(private readonly marketplaceService: MarketplaceService) {}

  // ==================== Public Endpoints ====================

  /**
   * List and search servers with filters and pagination
   * GET /api/v1/marketplace/servers
   */
  @Get('servers')
  async listServers(
    @Query() query: SearchServersDto,
  ): Promise<PaginatedResponse<ServerSummaryResponse>> {
    return this.marketplaceService.search(query);
  }

  /**
   * Get featured servers
   * GET /api/v1/marketplace/servers/featured
   */
  @Get('servers/featured')
  async getFeaturedServers(
    @Query('limit') limit?: number,
  ): Promise<ServerSummaryResponse[]> {
    return this.marketplaceService.getFeatured(limit || 10);
  }

  /**
   * Get popular servers by download count
   * GET /api/v1/marketplace/servers/popular
   */
  @Get('servers/popular')
  async getPopularServers(
    @Query('limit') limit?: number,
  ): Promise<ServerSummaryResponse[]> {
    return this.marketplaceService.getPopular(limit || 10);
  }

  /**
   * Get recently added servers
   * GET /api/v1/marketplace/servers/recent
   */
  @Get('servers/recent')
  async getRecentServers(
    @Query('limit') limit?: number,
  ): Promise<ServerSummaryResponse[]> {
    return this.marketplaceService.getRecent(limit || 10);
  }

  /**
   * Get all categories with server counts
   * GET /api/v1/marketplace/categories
   */
  @Get('categories')
  async getCategories(): Promise<CategoryResponse[]> {
    return this.marketplaceService.getCategories();
  }

  /**
   * Get a server by slug
   * GET /api/v1/marketplace/servers/:slug
   */
  @Get('servers/:slug')
  async getServerBySlug(@Param('slug') slug: string): Promise<ServerResponse> {
    return this.marketplaceService.findBySlug(slug);
  }

  /**
   * Record a download and increment counter
   * POST /api/v1/marketplace/servers/:id/download
   */
  @Post('servers/:id/download')
  @HttpCode(HttpStatus.OK)
  async recordDownload(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ success: boolean }> {
    await this.marketplaceService.incrementDownloadCount(id);
    return { success: true };
  }

  // ==================== Protected Endpoints ====================

  /**
   * Create a new MCP server
   * POST /api/v1/marketplace/servers
   */
  @Post('servers')
  async createServer(
    @Body() dto: CreateServerDto,
    @Req() req: Request,
  ): Promise<ServerResponse> {
    const user = requireUser(req);
    return this.marketplaceService.create(dto, user);
  }

  /**
   * Get current user's servers
   * GET /api/v1/marketplace/my-servers
   */
  @Get('my-servers')
  async getMyServers(@Req() req: Request): Promise<ServerSummaryResponse[]> {
    const user = requireUser(req);
    return this.marketplaceService.findByUser(user.id);
  }

  /**
   * Update a server
   * PATCH /api/v1/marketplace/servers/:id
   */
  @Patch('servers/:id')
  async updateServer(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateServerDto,
    @Req() req: Request,
  ): Promise<ServerResponse> {
    const user = requireUser(req);
    return this.marketplaceService.update(id, dto, user);
  }

  /**
   * Delete a server
   * DELETE /api/v1/marketplace/servers/:id
   */
  @Delete('servers/:id')
  @HttpCode(HttpStatus.OK)
  async deleteServer(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<{ success: boolean }> {
    const user = requireUser(req);
    await this.marketplaceService.delete(id, user);
    return { success: true };
  }

  /**
   * Publish a server (make it available in marketplace)
   * POST /api/v1/marketplace/servers/:id/publish
   */
  @Post('servers/:id/publish')
  async publishServer(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<ServerResponse> {
    const user = requireUser(req);
    return this.marketplaceService.publish(id, user);
  }

  /**
   * Unpublish a server (remove from public marketplace)
   * POST /api/v1/marketplace/servers/:id/unpublish
   */
  @Post('servers/:id/unpublish')
  async unpublishServer(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<ServerResponse> {
    const user = requireUser(req);
    return this.marketplaceService.unpublish(id, user);
  }
}
