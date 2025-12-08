import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
} from '@nestjs/common';
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
import { Public } from '../auth/decorators/public.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

@Controller('api/v1/marketplace')
export class MarketplaceController {
  constructor(private readonly marketplaceService: MarketplaceService) {}

  // ==================== Public Endpoints ====================

  /**
   * List and search servers with filters and pagination
   * GET /api/v1/marketplace/servers
   */
  @Public()
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
  @Public()
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
  @Public()
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
  @Public()
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
  @Public()
  @Get('categories')
  async getCategories(): Promise<CategoryResponse[]> {
    return this.marketplaceService.getCategories();
  }

  /**
   * Get a server by slug
   * GET /api/v1/marketplace/servers/:slug
   */
  @Public()
  @Get('servers/:slug')
  async getServerBySlug(@Param('slug') slug: string): Promise<ServerResponse> {
    return this.marketplaceService.findBySlug(slug);
  }

  /**
   * Record a download and increment counter
   * POST /api/v1/marketplace/servers/:id/download
   */
  @Public()
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
    @CurrentUser() user: User,
  ): Promise<ServerResponse> {
    return this.marketplaceService.create(dto, user);
  }

  /**
   * Get current user's servers
   * GET /api/v1/marketplace/my-servers
   */
  @Get('my-servers')
  async getMyServers(@CurrentUser() user: User): Promise<ServerSummaryResponse[]> {
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
    @CurrentUser() user: User,
  ): Promise<ServerResponse> {
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
    @CurrentUser() user: User,
  ): Promise<{ success: boolean }> {
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
    @CurrentUser() user: User,
  ): Promise<ServerResponse> {
    return this.marketplaceService.publish(id, user);
  }

  /**
   * Unpublish a server (remove from public marketplace)
   * POST /api/v1/marketplace/servers/:id/unpublish
   */
  @Post('servers/:id/unpublish')
  async unpublishServer(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
  ): Promise<ServerResponse> {
    return this.marketplaceService.unpublish(id, user);
  }
}
