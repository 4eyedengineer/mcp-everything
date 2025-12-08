import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, ILike, In, FindOptionsWhere } from 'typeorm';
import { McpServer } from '../database/entities/mcp-server.entity';
import { User } from '../database/entities/user.entity';
import { CreateServerDto } from './dto/create-server.dto';
import { UpdateServerDto, AdminUpdateServerDto } from './dto/update-server.dto';
import {
  SearchServersDto,
  SortField,
  SortOrder,
  PaginatedResponse,
} from './dto/search-servers.dto';
import {
  ServerResponse,
  ServerSummaryResponse,
  CategoryResponse,
} from './dto/server-response.dto';
import { MCP_SERVER_CATEGORIES, McpServerCategory } from './types/categories';

@Injectable()
export class MarketplaceService {
  private readonly logger = new Logger(MarketplaceService.name);

  constructor(
    @InjectRepository(McpServer)
    private readonly serverRepository: Repository<McpServer>,
  ) {}

  /**
   * Generate a URL-friendly slug from a name
   */
  private generateSlug(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }

  /**
   * Ensure slug is unique by appending a number if necessary
   */
  private async ensureUniqueSlug(slug: string, excludeId?: string): Promise<string> {
    let uniqueSlug = slug;
    let counter = 1;

    while (true) {
      const existing = await this.serverRepository.findOne({
        where: { slug: uniqueSlug },
      });

      if (!existing || existing.id === excludeId) {
        return uniqueSlug;
      }

      uniqueSlug = `${slug}-${counter}`;
      counter++;
    }
  }

  /**
   * Map entity to response DTO
   */
  private toServerResponse(server: McpServer): ServerResponse {
    return {
      id: server.id,
      name: server.name,
      slug: server.slug,
      description: server.description,
      longDescription: server.longDescription,
      category: server.category as McpServerCategory,
      tags: server.tags,
      visibility: server.visibility,
      author: server.author
        ? {
            id: server.author.id,
            firstName: server.author.firstName,
            lastName: server.author.lastName,
            githubUsername: server.author.githubUsername,
          }
        : undefined,
      repositoryUrl: server.repositoryUrl,
      gistUrl: server.gistUrl,
      downloadUrl: server.downloadUrl,
      tools: server.tools,
      resources: server.resources,
      envVars: server.envVars,
      language: server.language,
      downloadCount: server.downloadCount,
      viewCount: server.viewCount,
      rating: Number(server.rating),
      ratingCount: server.ratingCount,
      status: server.status,
      featured: server.featured,
      sourceConversationId: server.sourceConversationId,
      metadata: server.metadata,
      createdAt: server.createdAt,
      updatedAt: server.updatedAt,
      publishedAt: server.publishedAt,
    };
  }

  /**
   * Map entity to summary response DTO
   */
  private toServerSummary(server: McpServer): ServerSummaryResponse {
    return {
      id: server.id,
      name: server.name,
      slug: server.slug,
      description: server.description,
      category: server.category as McpServerCategory,
      tags: server.tags,
      author: server.author
        ? {
            id: server.author.id,
            firstName: server.author.firstName,
            lastName: server.author.lastName,
            githubUsername: server.author.githubUsername,
          }
        : undefined,
      downloadCount: server.downloadCount,
      rating: Number(server.rating),
      ratingCount: server.ratingCount,
      featured: server.featured,
      language: server.language,
      createdAt: server.createdAt,
    };
  }

  /**
   * Create a new MCP server
   */
  async create(dto: CreateServerDto, user: User): Promise<ServerResponse> {
    const slug = await this.ensureUniqueSlug(this.generateSlug(dto.name));

    const server = this.serverRepository.create({
      ...dto,
      slug,
      authorId: user.id,
      author: user,
      status: 'pending',
      visibility: dto.visibility || 'public',
      language: dto.language || 'typescript',
    });

    const saved = await this.serverRepository.save(server);
    this.logger.log(`Created MCP server: ${saved.id} (${saved.name}) by user ${user.id}`);

    return this.toServerResponse(saved);
  }

  /**
   * Search and list servers with filters and pagination
   */
  async search(dto: SearchServersDto): Promise<PaginatedResponse<ServerSummaryResponse>> {
    const {
      query,
      category,
      tags,
      language,
      authorId,
      sortBy = SortField.DOWNLOADS,
      sortOrder = SortOrder.DESC,
      page = 1,
      limit = 20,
      featured,
      status,
    } = dto;

    const queryBuilder = this.serverRepository
      .createQueryBuilder('server')
      .leftJoinAndSelect('server.author', 'author');

    // Only show approved and public servers for public searches
    // Unless status is explicitly provided (admin use case)
    if (!status) {
      queryBuilder.andWhere('server.status = :status', { status: 'approved' });
      queryBuilder.andWhere('server.visibility = :visibility', { visibility: 'public' });
    } else {
      queryBuilder.andWhere('server.status = :status', { status });
    }

    // Text search on name and description
    if (query) {
      queryBuilder.andWhere(
        '(server.name ILIKE :query OR server.description ILIKE :query)',
        { query: `%${query}%` },
      );
    }

    // Filter by category
    if (category) {
      queryBuilder.andWhere('server.category = :category', { category });
    }

    // Filter by tags (any match)
    if (tags && tags.length > 0) {
      queryBuilder.andWhere('server.tags && :tags', { tags });
    }

    // Filter by language
    if (language) {
      queryBuilder.andWhere('server.language = :language', { language });
    }

    // Filter by author
    if (authorId) {
      queryBuilder.andWhere('server.authorId = :authorId', { authorId });
    }

    // Filter by featured
    if (featured !== undefined) {
      queryBuilder.andWhere('server.featured = :featured', { featured });
    }

    // Sorting
    const sortColumn = this.getSortColumn(sortBy);
    queryBuilder.orderBy(`server.${sortColumn}`, sortOrder === SortOrder.ASC ? 'ASC' : 'DESC');

    // Secondary sort by name for consistency
    if (sortBy !== SortField.NAME) {
      queryBuilder.addOrderBy('server.name', 'ASC');
    }

    // Pagination
    const offset = (page - 1) * limit;
    queryBuilder.skip(offset).take(limit);

    // Execute query
    const [items, total] = await queryBuilder.getManyAndCount();

    const totalPages = Math.ceil(total / limit);

    return {
      items: items.map((s) => this.toServerSummary(s)),
      total,
      page,
      limit,
      totalPages,
      hasNext: page < totalPages,
      hasPrevious: page > 1,
    };
  }

  private getSortColumn(sortBy: SortField): string {
    switch (sortBy) {
      case SortField.DOWNLOADS:
        return 'downloadCount';
      case SortField.RATING:
        return 'rating';
      case SortField.RECENT:
        return 'createdAt';
      case SortField.NAME:
        return 'name';
      default:
        return 'downloadCount';
    }
  }

  /**
   * Get featured servers
   */
  async getFeatured(limit = 10): Promise<ServerSummaryResponse[]> {
    const servers = await this.serverRepository.find({
      where: {
        featured: true,
        status: 'approved',
        visibility: 'public',
      },
      relations: ['author'],
      order: { downloadCount: 'DESC' },
      take: limit,
    });

    return servers.map((s) => this.toServerSummary(s));
  }

  /**
   * Get popular servers by download count
   */
  async getPopular(limit = 10): Promise<ServerSummaryResponse[]> {
    const servers = await this.serverRepository.find({
      where: {
        status: 'approved',
        visibility: 'public',
      },
      relations: ['author'],
      order: { downloadCount: 'DESC' },
      take: limit,
    });

    return servers.map((s) => this.toServerSummary(s));
  }

  /**
   * Get recently added servers
   */
  async getRecent(limit = 10): Promise<ServerSummaryResponse[]> {
    const servers = await this.serverRepository.find({
      where: {
        status: 'approved',
        visibility: 'public',
      },
      relations: ['author'],
      order: { createdAt: 'DESC' },
      take: limit,
    });

    return servers.map((s) => this.toServerSummary(s));
  }

  /**
   * Get a server by slug
   */
  async findBySlug(slug: string): Promise<ServerResponse> {
    const server = await this.serverRepository.findOne({
      where: { slug },
      relations: ['author'],
    });

    if (!server) {
      throw new NotFoundException(`Server with slug '${slug}' not found`);
    }

    // Check visibility
    if (server.visibility === 'private') {
      throw new NotFoundException(`Server with slug '${slug}' not found`);
    }

    // Increment view count
    await this.serverRepository.increment({ id: server.id }, 'viewCount', 1);
    server.viewCount += 1;

    return this.toServerResponse(server);
  }

  /**
   * Get a server by ID
   */
  async findById(id: string): Promise<ServerResponse> {
    const server = await this.serverRepository.findOne({
      where: { id },
      relations: ['author'],
    });

    if (!server) {
      throw new NotFoundException(`Server with ID '${id}' not found`);
    }

    return this.toServerResponse(server);
  }

  /**
   * Get servers owned by a user
   */
  async findByUser(userId: string): Promise<ServerSummaryResponse[]> {
    const servers = await this.serverRepository.find({
      where: { authorId: userId },
      relations: ['author'],
      order: { updatedAt: 'DESC' },
    });

    return servers.map((s) => this.toServerSummary(s));
  }

  /**
   * Update a server
   */
  async update(id: string, dto: UpdateServerDto, user: User): Promise<ServerResponse> {
    const server = await this.serverRepository.findOne({
      where: { id },
      relations: ['author'],
    });

    if (!server) {
      throw new NotFoundException(`Server with ID '${id}' not found`);
    }

    // Check ownership
    if (server.authorId !== user.id) {
      throw new ForbiddenException('You can only update your own servers');
    }

    // If name is being changed, update slug
    if (dto.name && dto.name !== server.name) {
      server.slug = await this.ensureUniqueSlug(this.generateSlug(dto.name), id);
    }

    // Apply updates
    Object.assign(server, dto);

    const saved = await this.serverRepository.save(server);
    this.logger.log(`Updated MCP server: ${saved.id} (${saved.name}) by user ${user.id}`);

    return this.toServerResponse(saved);
  }

  /**
   * Admin update a server (can change status, featured, etc.)
   */
  async adminUpdate(id: string, dto: AdminUpdateServerDto): Promise<ServerResponse> {
    const server = await this.serverRepository.findOne({
      where: { id },
      relations: ['author'],
    });

    if (!server) {
      throw new NotFoundException(`Server with ID '${id}' not found`);
    }

    // If name is being changed, update slug
    if (dto.name && dto.name !== server.name) {
      server.slug = await this.ensureUniqueSlug(this.generateSlug(dto.name), id);
    }

    // Apply updates including admin-only fields
    Object.assign(server, dto);

    const saved = await this.serverRepository.save(server);
    this.logger.log(`Admin updated MCP server: ${saved.id} (${saved.name})`);

    return this.toServerResponse(saved);
  }

  /**
   * Delete a server
   */
  async delete(id: string, user: User): Promise<void> {
    const server = await this.serverRepository.findOne({
      where: { id },
    });

    if (!server) {
      throw new NotFoundException(`Server with ID '${id}' not found`);
    }

    // Check ownership
    if (server.authorId !== user.id) {
      throw new ForbiddenException('You can only delete your own servers');
    }

    await this.serverRepository.remove(server);
    this.logger.log(`Deleted MCP server: ${id} by user ${user.id}`);
  }

  /**
   * Publish a server (change status to approved)
   */
  async publish(id: string, user: User): Promise<ServerResponse> {
    const server = await this.serverRepository.findOne({
      where: { id },
      relations: ['author'],
    });

    if (!server) {
      throw new NotFoundException(`Server with ID '${id}' not found`);
    }

    // Check ownership
    if (server.authorId !== user.id) {
      throw new ForbiddenException('You can only publish your own servers');
    }

    // For now, auto-approve. In production, this might go to 'pending' for review
    server.status = 'approved';
    server.publishedAt = new Date();

    const saved = await this.serverRepository.save(server);
    this.logger.log(`Published MCP server: ${saved.id} (${saved.name}) by user ${user.id}`);

    return this.toServerResponse(saved);
  }

  /**
   * Unpublish a server (change status back to pending)
   */
  async unpublish(id: string, user: User): Promise<ServerResponse> {
    const server = await this.serverRepository.findOne({
      where: { id },
      relations: ['author'],
    });

    if (!server) {
      throw new NotFoundException(`Server with ID '${id}' not found`);
    }

    // Check ownership
    if (server.authorId !== user.id) {
      throw new ForbiddenException('You can only unpublish your own servers');
    }

    server.status = 'pending';

    const saved = await this.serverRepository.save(server);
    this.logger.log(`Unpublished MCP server: ${saved.id} (${saved.name}) by user ${user.id}`);

    return this.toServerResponse(saved);
  }

  /**
   * Get all categories with server counts
   */
  async getCategories(): Promise<CategoryResponse[]> {
    const counts = await this.serverRepository
      .createQueryBuilder('server')
      .select('server.category', 'category')
      .addSelect('COUNT(*)', 'count')
      .where('server.status = :status', { status: 'approved' })
      .andWhere('server.visibility = :visibility', { visibility: 'public' })
      .groupBy('server.category')
      .getRawMany();

    const countMap = new Map<string, number>();
    for (const row of counts) {
      countMap.set(row.category, parseInt(row.count, 10));
    }

    return Object.entries(MCP_SERVER_CATEGORIES).map(([key, value]) => ({
      key,
      name: value.name,
      description: value.description,
      examples: value.examples,
      serverCount: countMap.get(key) || 0,
    }));
  }

  /**
   * Increment download count
   */
  async incrementDownloadCount(id: string): Promise<void> {
    await this.serverRepository.increment({ id }, 'downloadCount', 1);
  }
}
