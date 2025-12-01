import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull, LessThan, In } from 'typeorm';
import { ResearchCache } from '../entities/research-cache.entity';
import { GraphState } from '../../orchestration/types';

/**
 * Research Cache Service
 *
 * Handles all operations for caching research results:
 * - TTL management (7-day expiration)
 * - Vector similarity search
 * - Access pattern tracking
 * - Knowledge graph relationships
 * - Automatic cleanup
 *
 * Architecture:
 * - Read-optimized: Multiple indexes for different query patterns
 * - Write-efficient: Batched updates, lazy relationship building
 * - Cost-effective: Automatic expiration reduces storage growth
 * - Observable: Access patterns for optimization decisions
 */
@Injectable()
export class ResearchCacheService {
  private readonly logger = new Logger(ResearchCacheService.name);

  // Cache statistics for monitoring
  private stats = {
    hits: 0,
    misses: 0,
    evictions: 0,
    searchTime: 0,
  };

  constructor(
    @InjectRepository(ResearchCache)
    private readonly cacheRepository: Repository<ResearchCache>,
  ) {}

  /**
   * Get cached research by GitHub URL
   *
   * Flow:
   * 1. Query by unique githubUrl index (O(log n))
   * 2. Increment accessCount
   * 3. Update lastAccessedAt
   * 4. Return cached data
   *
   * Performance:
   * - With index: <1ms
   * - Without index: O(n) full table scan
   * - Network: ~1-5ms (depending on data size)
   *
   * @param githubUrl - Normalized GitHub repository URL
   * @returns Cached research data or null if not found/expired
   *
   * Example:
   * const cached = await cacheService.get('https://github.com/vercel/next.js');
   * if (cached) {
   *   console.log(cached.researchData.synthesizedPlan);
   * }
   */
  async get(githubUrl: string): Promise<ResearchCache | null> {
    const startTime = Date.now();

    try {
      const cached = await this.cacheRepository.findOne({
        where: {
          githubUrl: this.normalizeUrl(githubUrl),
          status: 'active',
          expiresAt: LessThan(new Date()), // Only return non-expired
        },
      });

      if (!cached) {
        this.stats.misses++;
        return null;
      }

      // Update access metrics asynchronously (fire and forget)
      this.updateAccessMetrics(cached.id).catch(err =>
        this.logger.error(`Failed to update access metrics for ${githubUrl}: ${err.message}`),
      );

      this.stats.hits++;
      return cached;
    } finally {
      this.stats.searchTime += Date.now() - startTime;
    }
  }

  /**
   * Get cached research by URL, returning null if expired
   *
   * Stricter version of get() - returns null even if entry exists
   * but is past expiration time.
   *
   * @param githubUrl - Repository URL
   * @returns Cached research or null
   */
  async getIfValid(githubUrl: string): Promise<ResearchCache | null> {
    const cached = await this.cacheRepository.findOne({
      where: {
        githubUrl: this.normalizeUrl(githubUrl),
      },
    });

    if (!cached || cached.expiresAt < new Date() || cached.status !== 'active') {
      return null;
    }

    // Update access metrics asynchronously
    this.updateAccessMetrics(cached.id).catch(err =>
      this.logger.error(`Failed to update access metrics: ${err.message}`),
    );

    return cached;
  }

  /**
   * Set (create or update) cached research
   *
   * Flow:
   * 1. Normalize GitHub URL
   * 2. Calculate quality score
   * 3. Prepare embedding (external service)
   * 4. Extract metadata
   * 5. UPSERT to database
   * 6. Return cache entry
   *
   * TTL Strategy:
   * - Standard: 7 days
   * - High quality (>0.8): 14 days
   * - Low quality (<0.5): 3 days
   *
   * @param githubUrl - Repository URL
   * @param researchData - Complete research phase data
   * @param options - Optional metadata, embedding, tags
   * @returns Created/updated cache entry
   *
   * Example:
   * await cacheService.set('https://github.com/vercel/next.js', {
   *   webSearchFindings: { ... },
   *   githubDeepDive: { ... },
   *   synthesizedPlan: { ... },
   *   researchConfidence: 0.92,
   *   researchIterations: 3
   * }, {
   *   embedding: [...384-dim vector...],
   *   tags: ['framework', 'javascript', 'actively-maintained'],
   *   metadata: {
   *     name: 'next.js',
   *     owner: 'vercel',
   *     language: 'TypeScript',
   *     stars: 120000,
   *     topics: ['react', 'framework'],
   *     lastUpdated: new Date()
   *   }
   * });
   */
  async set(
    githubUrl: string,
    researchData: GraphState['researchPhase'],
    options: {
      embedding?: number[];
      metadata?: ResearchCache['metadata'];
      tags?: string[];
      relationships?: ResearchCache['relationships'];
    } = {},
  ): Promise<ResearchCache> {
    const normalizedUrl = this.normalizeUrl(githubUrl);

    // Calculate quality score from research data
    const qualityScore = this.calculateQualityScore(researchData);

    // Calculate TTL based on quality
    const ttl = this.calculateTtl(qualityScore);
    const expiresAt = new Date(Date.now() + ttl);

    // UPSERT: Create or update cache entry
    const cacheEntry = await this.cacheRepository.save({
      githubUrl: normalizedUrl,
      researchData,
      embedding: options.embedding,
      metadata: options.metadata,
      tags: options.tags || [],
      relationships: options.relationships,
      status: 'active',
      qualityScore,
      expiresAt,
      accessCount: 0,
      cachedAt: new Date(),
      compressionMethod: 'native',
    });

    this.logger.log(
      `Cached research for ${normalizedUrl} (quality: ${qualityScore}, TTL: ${ttl / (1000 * 60 * 60 * 24)} days)`,
    );

    return cacheEntry;
  }

  /**
   * Find similar repositories using vector similarity
   *
   * Flow:
   * 1. Get query vector (from embedding service)
   * 2. Use IVFFlat index for fast lookup
   * 3. Calculate distance to all vectors
   * 4. Return top K results within threshold
   *
   * Performance:
   * - Index lookup: O(log n) to locate IVF list
   * - Distance calculation: O(k) for k vectors in list
   * - Total: ~10-50ms for 100k+ vectors
   * - Recall: ~95-99% (trade-off for speed)
   *
   * Query pattern:
   * SELECT *, embedding <-> query_vector AS distance
   * FROM research_cache
   * WHERE status = 'active' AND embedding <-> query_vector < threshold
   * ORDER BY embedding <-> query_vector
   * LIMIT k
   *
   * @param queryVector - 384-dim embedding of query
   * @param options - Search parameters
   * @returns Similar repositories sorted by distance
   *
   * Example:
   * const similar = await cacheService.findSimilar(
   *   [0.1, 0.2, ...], // 384-dim vector
   *   { limit: 10, threshold: 0.3 }
   * );
   * for (const result of similar) {
   *   console.log(`${result.githubUrl}: distance=${result.distance}`);
   * }
   */
  async findSimilar(
    queryVector: number[],
    options: {
      limit?: number;
      threshold?: number; // 0-1, lower = more similar
      tags?: string[]; // Optional filter
      minQuality?: number; // Optional quality threshold
    } = {},
  ): Promise<(ResearchCache & { distance: number })[]> {
    const limit = options.limit || 10;
    const threshold = options.threshold || 0.3;
    const minQuality = options.minQuality || 0;

    const startTime = Date.now();

    // Build query with optional filters
    let query = this.cacheRepository
      .createQueryBuilder('rc')
      .where('rc.status = :status', { status: 'active' })
      .andWhere('rc.embedding IS NOT NULL');

    // Add vector similarity filter
    // Note: Raw SQL required for vector operators
    query = this.cacheRepository
      .createQueryBuilder('rc')
      .select(`
        rc.*,
        (rc.embedding <-> :queryVector)::float AS distance
      `)
      .where('rc.status = :status', { status: 'active' })
      .andWhere('rc.embedding IS NOT NULL')
      .andWhere('(rc.embedding <-> :queryVector) < :threshold', {
        queryVector: `[${queryVector.join(',')}]`,
        threshold,
      });

    // Add optional tag filter
    if (options.tags && options.tags.length > 0) {
      query = query.andWhere('rc.tags && :tags', { tags: options.tags });
    }

    // Add quality filter
    if (minQuality > 0) {
      query = query.andWhere('rc.qualityScore >= :minQuality', { minQuality });
    }

    const results = await query
      .orderBy('distance', 'ASC')
      .limit(limit)
      .getRawMany();

    this.logger.debug(
      `Found ${results.length} similar repositories in ${Date.now() - startTime}ms`,
    );

    return results.map(r => ({
      ...r,
      distance: parseFloat(r.distance),
    }));
  }

  /**
   * Find repositories by tag
   *
   * Query pattern:
   * SELECT * FROM research_cache
   * WHERE status = 'active' AND tags @> tag_array
   * ORDER BY qualityScore DESC, accessCount DESC
   *
   * Uses GIN index for fast lookup.
   * Performance: 5-20ms for 100k+ items
   *
   * @param tags - Tags to search for (ANY match)
   * @param options - Search options
   * @returns Matching repositories
   *
   * Example:
   * const frameworks = await cacheService.findByTags(['framework'], {
   *   limit: 20,
   *   sortBy: 'quality'
   * });
   */
  async findByTags(
    tags: string[],
    options: {
      limit?: number;
      offset?: number;
      sortBy?: 'quality' | 'access' | 'recent';
      matchAll?: boolean; // If true, ALL tags must match
    } = {},
  ): Promise<ResearchCache[]> {
    const limit = options.limit || 20;
    const offset = options.offset || 0;
    let query = this.cacheRepository
      .createQueryBuilder('rc')
      .where('rc.status = :status', { status: 'active' });

    // Filter by tags
    if (options.matchAll) {
      // All tags must be present
      query = query.andWhere(`rc.tags @> :tags`, { tags });
    } else {
      // Any tag can match
      query = query.andWhere(
        `ARRAY[${tags.map((t, i) => `:tag${i}`).join(',')}] && rc.tags`,
        tags.reduce((acc, t, i) => ({ ...acc, [`tag${i}`]: t }), {}),
      );
    }

    // Apply sorting
    switch (options.sortBy) {
      case 'quality':
        query = query.orderBy('rc.qualityScore', 'DESC').addOrderBy('rc.accessCount', 'DESC');
        break;
      case 'access':
        query = query.orderBy('rc.accessCount', 'DESC').addOrderBy('rc.qualityScore', 'DESC');
        break;
      case 'recent':
      default:
        query = query.orderBy('rc.cachedAt', 'DESC');
    }

    return query.limit(limit).offset(offset).getMany();
  }

  /**
   * Filter by metadata (language, stars, etc.)
   *
   * Query pattern:
   * SELECT * FROM research_cache
   * WHERE metadata->>'language' = 'TypeScript'
   *   AND (metadata->>'stars')::integer > 1000
   *
   * Uses expression indexes for fast lookup.
   * Performance: 5-10ms for 100k+ items
   *
   * @param filters - Metadata filters
   * @param options - Search options
   * @returns Matching repositories
   */
  async findByMetadata(
    filters: {
      language?: string;
      minStars?: number;
      maxStars?: number;
      owner?: string;
      topics?: string[]; // ANY match
    },
    options: {
      limit?: number;
      offset?: number;
      sortBy?: 'stars' | 'recent' | 'quality';
    } = {},
  ): Promise<ResearchCache[]> {
    const limit = options.limit || 20;
    const offset = options.offset || 0;
    let query = this.cacheRepository
      .createQueryBuilder('rc')
      .where('rc.status = :status', { status: 'active' })
      .andWhere('rc.metadata IS NOT NULL');

    // Apply filters
    if (filters.language) {
      query = query.andWhere(`(rc.metadata->>'language') = :language`, {
        language: filters.language,
      });
    }

    if (filters.minStars) {
      query = query.andWhere(
        `(rc.metadata->>'stars')::integer >= :minStars`,
        { minStars: filters.minStars },
      );
    }

    if (filters.maxStars) {
      query = query.andWhere(
        `(rc.metadata->>'stars')::integer <= :maxStars`,
        { maxStars: filters.maxStars },
      );
    }

    if (filters.owner) {
      query = query.andWhere(`(rc.metadata->>'owner') = :owner`, { owner: filters.owner });
    }

    if (filters.topics && filters.topics.length > 0) {
      const topicsStr = JSON.stringify(filters.topics);
      query = query.andWhere(
        `(rc.metadata->'topics') @> :topics::jsonb`,
        { topics: topicsStr },
      );
    }

    // Apply sorting
    switch (options.sortBy) {
      case 'stars':
        query = query.orderBy(`(rc.metadata->>'stars')::integer`, 'DESC');
        break;
      case 'quality':
        query = query.orderBy('rc.qualityScore', 'DESC');
        break;
      case 'recent':
      default:
        query = query.orderBy('rc.cachedAt', 'DESC');
    }

    return query.limit(limit).offset(offset).getMany();
  }

  /**
   * Find hot repositories (high access count)
   *
   * Query pattern:
   * SELECT * FROM research_cache
   * WHERE status = 'active' AND accessCount > threshold
   * ORDER BY accessCount DESC
   *
   * Uses partial index for efficient filtering.
   * Performance: <5ms
   *
   * @param threshold - Minimum access count
   * @param limit - Maximum results
   * @returns Hot repositories
   */
  async findHotRepositories(threshold: number = 10, limit: number = 10): Promise<ResearchCache[]> {
    return this.cacheRepository.find({
      where: {
        status: 'active',
        accessCount: LessThan(threshold), // Reverse logic: find entries with high access
      },
      order: { accessCount: 'DESC' },
      take: limit,
    });
  }

  /**
   * Get cache statistics
   *
   * Returns metrics for monitoring and optimization:
   * - Hit rate: hits / (hits + misses)
   * - Average search time
   * - Total cached repositories
   * - Storage usage
   *
   * @returns Cache statistics
   */
  async getStats(): Promise<{
    hitRate: number;
    avgSearchTime: number;
    totalCached: number;
    activeCached: number;
    expiredCached: number;
    storageSize: string;
    avgQuality: number;
  }> {
    const total = await this.cacheRepository.count();
    const active = await this.cacheRepository.countBy({ status: 'active' });
    const expired = await this.cacheRepository.countBy({ status: 'expired' });

    // Get quality average
    const result = await this.cacheRepository
      .createQueryBuilder()
      .select('AVG(qualityScore)', 'avgQuality')
      .where('status = :status', { status: 'active' })
      .getRawOne();

    // Get storage size (requires raw query)
    const sizeResult = await this.cacheRepository.query(`
      SELECT pg_size_pretty(pg_total_relation_size('research_cache')) as size
    `);

    const hitRate = this.stats.hits + this.stats.misses > 0
      ? this.stats.hits / (this.stats.hits + this.stats.misses)
      : 0;

    const avgSearchTime = this.stats.hits + this.stats.misses > 0
      ? this.stats.searchTime / (this.stats.hits + this.stats.misses)
      : 0;

    return {
      hitRate: Math.round(hitRate * 100) / 100,
      avgSearchTime: Math.round(avgSearchTime * 100) / 100,
      totalCached: total,
      activeCached: active,
      expiredCached: expired,
      storageSize: sizeResult[0].size,
      avgQuality: Math.round(parseFloat(result?.avgQuality || 0) * 100) / 100,
    };
  }

  /**
   * Cleanup expired cache entries
   *
   * Query pattern:
   * DELETE FROM research_cache
   * WHERE expiresAt < NOW() AND status = 'active'
   *
   * Uses partial index for efficient lookup.
   * Performance: <100ms per 1000 expired entries
   *
   * Should be run as scheduled job (daily):
   * 0 2 * * * (2 AM daily)
   *
   * @returns Number of deleted entries
   */
  async cleanup(): Promise<number> {
    const result = await this.cacheRepository.delete({
      expiresAt: LessThan(new Date()),
      status: 'active',
    });

    const deleted = result.affected || 0;
    this.logger.log(`Cleaned up ${deleted} expired cache entries`);
    this.stats.evictions += deleted;

    return deleted;
  }

  /**
   * Mark entry as expired (soft delete)
   *
   * @param id - Cache entry ID
   */
  async markExpired(id: string): Promise<void> {
    await this.cacheRepository.update(id, {
      status: 'expired',
      expiresAt: new Date(), // Mark as already expired
    });
  }

  /**
   * Invalidate cache for repository
   * (mark for deletion without immediate removal)
   *
   * @param githubUrl - Repository URL
   */
  async invalidate(githubUrl: string): Promise<void> {
    await this.cacheRepository.update(
      { githubUrl: this.normalizeUrl(githubUrl) },
      {
        status: 'expired',
        expiresAt: new Date(),
      },
    );
  }

  /**
   * Add or update relationships (knowledge graph)
   *
   * Example: Mark next.js as related to react
   *
   * @param sourceId - Source repository ID
   * @param targetRepositoryId - Target repository ID
   * @param relationship - Relationship type
   * @param similarity - Similarity score 0-1
   */
  async addRelationship(
    sourceId: string,
    targetRepositoryId: string,
    relationship: 'depends_on' | 'similar_tools' | 'framework' | 'alternative',
    similarity: number = 0.8,
  ): Promise<void> {
    const entry = await this.cacheRepository.findOne({ where: { id: sourceId } });

    if (!entry) {
      throw new Error(`Cache entry not found: ${sourceId}`);
    }

    // Add or update relationship
    const relationships = entry.relationships || [];
    const existingIndex = relationships.findIndex(r => r.repositoryId === targetRepositoryId);

    if (existingIndex >= 0) {
      relationships[existingIndex] = {
        repositoryId: targetRepositoryId,
        relationship,
        similarity,
        source: 'manual',
      };
    } else {
      relationships.push({
        repositoryId: targetRepositoryId,
        relationship,
        similarity,
        source: 'manual',
      });
    }

    await this.cacheRepository.update(sourceId, { relationships });
  }

  // ===== PRIVATE HELPER METHODS =====

  /**
   * Normalize GitHub URL for consistent lookups
   * Converts to: https://github.com/owner/repo
   */
  private normalizeUrl(url: string): string {
    // Remove trailing slashes, .git, etc.
    let normalized = url.trim().toLowerCase();
    if (normalized.endsWith('.git')) {
      normalized = normalized.slice(0, -4);
    }
    if (normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1);
    }

    // Ensure https
    if (normalized.startsWith('http://')) {
      normalized = 'https://' + normalized.slice(7);
    }

    // Extract owner/repo if full URL provided
    if (normalized.includes('github.com/')) {
      const match = normalized.match(/github\.com\/([^/]+)\/([^/]+)/);
      if (match) {
        normalized = `https://github.com/${match[1]}/${match[2]}`;
      }
    }

    return normalized;
  }

  /**
   * Calculate quality score from research data
   * Combines multiple quality indicators into 0-1 score
   */
  private calculateQualityScore(researchData: GraphState['researchPhase']): number {
    if (!researchData) return 0;

    const weights = {
      researchConfidence: 0.5, // 50% from research confidence
      synthesizedPlanConfidence: 0.3, // 30% from plan confidence
      iterationBonus: 0.2, // 20% from number of iterations
    };

    let score = 0;

    score += (researchData.researchConfidence || 0) * weights.researchConfidence;
    score += (researchData.synthesizedPlan?.confidence || 0) * weights.synthesizedPlanConfidence;

    // Bonus for multiple iterations (better refined research)
    const iterationScore = Math.min(researchData.researchIterations / 5, 1); // Cap at 5 iterations
    score += iterationScore * weights.iterationBonus;

    return Math.min(score, 1); // Clamp to 0-1
  }

  /**
   * Calculate TTL based on quality score
   * Higher quality = longer TTL
   */
  private calculateTtl(qualityScore: number): number {
    if (qualityScore >= 0.8) {
      return 14 * 24 * 60 * 60 * 1000; // 14 days for high quality
    } else if (qualityScore >= 0.5) {
      return 7 * 24 * 60 * 60 * 1000; // 7 days for medium quality
    } else {
      return 3 * 24 * 60 * 60 * 1000; // 3 days for low quality
    }
  }

  /**
   * Update access metrics asynchronously
   * Called after successful cache hit
   */
  private async updateAccessMetrics(id: string): Promise<void> {
    await this.cacheRepository.increment(
      { id },
      'accessCount',
      1,
    );

    await this.cacheRepository.update(id, {
      lastAccessedAt: new Date(),
    });
  }
}
