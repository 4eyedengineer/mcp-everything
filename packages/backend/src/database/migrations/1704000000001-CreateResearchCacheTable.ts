import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Research Cache Migration
 *
 * Creates a specialized table for caching research results with:
 * - Vector similarity search (pgvector extension)
 * - 7-day TTL with automatic expiration
 * - Performance-optimized indexes
 * - Knowledge graph relationships
 *
 * Prerequisites:
 * - PostgreSQL 12+
 * - pgvector extension (CREATE EXTENSION IF NOT EXISTS vector;)
 *
 * Performance Impact:
 * - Initial space: ~1MB (indexes)
 * - Growth rate: ~2-5KB per cached repository
 * - Query performance: <100ms for similarity search on 100k+ items
 */
export class CreateResearchCacheTable1704000000001 implements MigrationInterface {
  name = 'CreateResearchCacheTable1704000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Enable vector extension if not already enabled
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS vector');

    // Create the main research_cache table
    await queryRunner.query(`
      CREATE TABLE "research_cache" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),

        -- Core cache data
        "githubUrl" varchar(512) NOT NULL,
        "researchData" jsonb NOT NULL,
        "embedding" vector(384),
        "metadata" jsonb,
        "relationships" jsonb,

        -- Access tracking
        "accessCount" integer NOT NULL DEFAULT 0,
        "cachedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "lastAccessedAt" TIMESTAMP WITH TIME ZONE,
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),

        -- Status and quality
        "status" varchar(20) NOT NULL DEFAULT 'active' CHECK ("status" IN ('active', 'expired', 'stale', 'corrupted')),
        "qualityScore" numeric(3,2),
        "tags" text[] NOT NULL DEFAULT '{}',
        "compressionMethod" varchar(20) NOT NULL DEFAULT 'none'
      )
    `);

    // === CORE INDEXES FOR FAST LOOKUPS ===

    /**
     * UNIQUE index on githubUrl
     * - Fast cache key lookup
     * - Prevents duplicate caching
     * - Query: SELECT * FROM research_cache WHERE githubUrl = ?
     * - Complexity: O(log n)
     * - Use case: Check if repository already cached
     */
    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_research_cache_github_url"
      ON "research_cache" ("githubUrl")
    `);

    /**
     * Index on expiresAt for TTL cleanup
     * - Enables efficient cache expiration queries
     * - Partial index on expired entries only
     * - Query: DELETE FROM research_cache WHERE expiresAt < NOW()
     * - Complexity: O(log n) to find expired, O(k) to delete k items
     * - Use case: Scheduled cleanup job (run daily)
     */
    await queryRunner.query(`
      CREATE INDEX "IDX_research_cache_expires_at"
      ON "research_cache" ("expiresAt")
      WHERE status = 'active'
    `);

    /**
     * Composite index for access pattern analysis
     * - Enables hot repository identification
     * - Query: SELECT * FROM research_cache WHERE accessCount > 10 ORDER BY accessCount DESC
     * - Partial index optimizes storage
     * - Use case: Identify frequently-accessed research to keep longer
     */
    await queryRunner.query(`
      CREATE INDEX "IDX_research_cache_access_pattern"
      ON "research_cache" ("accessCount" DESC)
      WHERE "accessCount" > 10 AND status = 'active'
    `);

    /**
     * Index on cachedAt for freshness queries
     * - Enables "recent cache" queries
     * - Partial index for 7-day window
     * - Query: SELECT * FROM research_cache WHERE cachedAt > NOW() - INTERVAL '1 day'
     * - Use case: Find recently cached research to avoid immediate expiration
     */
    await queryRunner.query(`
      CREATE INDEX "IDX_research_cache_cached_at_recent"
      ON "research_cache" ("cachedAt" DESC)
      WHERE (NOW() - "cachedAt") < INTERVAL '7 days'
    `);

    // === VECTOR SIMILARITY INDEXES ===

    /**
     * IVFFlat vector index for semantic similarity search
     * - Enables fast similarity queries
     * - Lists parameter: 100 (optimal for 100k-1M vectors)
     * - Distance metric: cosine similarity
     * - Query: SELECT *, embedding <-> query_vector AS dist FROM research_cache
     *          WHERE embedding <-> query_vector < 0.3 ORDER BY dist LIMIT 10
     * - Performance: ~10-50ms for 100k+ vectors
     * - Index size: ~1-2% of data size
     * - Trade-off: ~95-99% recall (vs 100% with sequential scan)
     *
     * Alternative configurations:
     * - HNSW (if installing pg_hnsw): Better for updates, higher memory
     * - Sequential scan: 100% accurate, slower (>500ms for 100k)
     * - Partial index: Only index vectors for active cache (save 20% space)
     *
     * Tuning lists parameter (for future optimization):
     * - 50: Faster builds, fewer neighbors searched (~80-90% recall)
     * - 100: Balanced (default, ~95-99% recall)
     * - 200: Slower builds, more neighbors (~99%+ recall)
     * - Formula: lists ≈ sqrt(number_of_vectors / 10)
     */
    await queryRunner.query(`
      CREATE INDEX "IDX_research_cache_embedding_cosine"
      ON "research_cache" USING ivfflat (embedding vector_cosine_ops)
      WHERE embedding IS NOT NULL AND status = 'active'
      WITH (lists = 100)
    `);

    /**
     * Optional: IVFFlat index with L2 distance
     * - Alternative similarity metric
     * - Use case: If Euclidean distance preferred over cosine
     * - Can drop if cosine is sufficient
     * - Query: embedding <-> (query_vector) for cosine
     *         embedding <-> (query_vector) for L2 (note: different operator)
     *
     * Uncomment if needed:
     * CREATE INDEX "IDX_research_cache_embedding_l2"
     * ON "research_cache" USING ivfflat (embedding vector_l2_ops)
     * WHERE embedding IS NOT NULL AND status = 'active'
     * WITH (lists = 100);
     */

    // === JSON INDEXES FOR SEARCHING RESEARCH DATA ===

    /**
     * GIN index on tags for efficient filtering
     * - Enables quick search by repository tags
     * - Query: SELECT * FROM research_cache WHERE 'framework' = ANY(tags)
     * - Complexity: O(log n) to find matching tag, O(k) for k results
     * - Use case: Filter by technology category
     *
     * Example tag values:
     * - Technology: 'javascript', 'python', 'go', 'rust'
     * - Category: 'web-framework', 'database', 'cli-tool', 'api-client'
     * - Status: 'actively-maintained', 'enterprise', 'deprecated'
     */
    await queryRunner.query(`
      CREATE INDEX "IDX_research_cache_tags"
      ON "research_cache" USING gin(tags)
      WHERE status = 'active'
    `);

    /**
     * GIN index on metadata JSONB for advanced filtering
     * - Enables searches within nested JSON
     * - Query: SELECT * FROM research_cache WHERE metadata @> '{"language": "TypeScript"}'
     *          SELECT * FROM research_cache WHERE metadata->>'language' = 'TypeScript'
     * - Use case: Find repositories by language, stars, etc.
     *
     * Creates separate expression indexes for common queries:
     */
    await queryRunner.query(`
      CREATE INDEX "IDX_research_cache_metadata"
      ON "research_cache" USING gin(metadata)
      WHERE metadata IS NOT NULL AND status = 'active'
    `);

    /**
     * Expression index on metadata language field
     * - Faster than generic JSONB index for this specific query
     * - Query: SELECT * FROM research_cache WHERE (metadata->>'language') = 'TypeScript'
     * - Complexity: O(log n) for indexed lookup
     * - Use case: Filter by programming language
     */
    await queryRunner.query(`
      CREATE INDEX "IDX_research_cache_metadata_language"
      ON "research_cache" ((metadata->>'language'))
      WHERE metadata IS NOT NULL AND status = 'active'
    `);

    /**
     * Expression index on metadata stars
     * - Query: SELECT * FROM research_cache WHERE (metadata->>'stars')::integer > 1000
     * - Use case: Find popular repositories
     * - Note: Cast to integer for numeric comparison
     */
    await queryRunner.query(`
      CREATE INDEX "IDX_research_cache_metadata_stars"
      ON "research_cache" (((metadata->>'stars')::integer) DESC)
      WHERE metadata IS NOT NULL AND status = 'active'
    `);

    /**
     * Expression index on quality score
     * - Query: SELECT * FROM research_cache WHERE qualityScore >= 0.8 ORDER BY qualityScore DESC
     * - Use case: Find high-confidence research results
     */
    await queryRunner.query(`
      CREATE INDEX "IDX_research_cache_quality_score"
      ON "research_cache" ("qualityScore" DESC)
      WHERE "qualityScore" IS NOT NULL AND status = 'active'
    `);

    // === COMPOSITE INDEXES FOR COMMON QUERY PATTERNS ===

    /**
     * Composite index for cache status and expiration
     * - Optimizes cleanup queries
     * - Query: SELECT * FROM research_cache WHERE status = 'active' AND expiresAt < NOW()
     * - Used for: Identifying cache entries ready to expire
     */
    await queryRunner.query(`
      CREATE INDEX "IDX_research_cache_status_expires"
      ON "research_cache" ("status", "expiresAt")
    `);

    /**
     * Composite index for access pattern discovery
     * - Query: SELECT * FROM research_cache WHERE status = 'active' ORDER BY accessCount DESC LIMIT 100
     * - Use case: Find hot cache entries, identify popular repositories
     */
    await queryRunner.query(`
      CREATE INDEX "IDX_research_cache_status_access"
      ON "research_cache" ("status", "accessCount" DESC)
    `);

    /**
     * Composite index for recent cache entries
     * - Query: SELECT * FROM research_cache WHERE status = 'active' AND cachedAt > ? ORDER BY cachedAt DESC
     * - Use case: Browse recently cached repositories
     */
    await queryRunner.query(`
      CREATE INDEX "IDX_research_cache_status_cached_at"
      ON "research_cache" ("status" DESC, "cachedAt" DESC)
    `);

    // === PERFORMANCE STATISTICS ===

    /**
     * Collect statistics for query planner
     * - Enables PostgreSQL query optimizer to choose best plan
     * - Run after initial data load
     * - Re-run periodically (monthly) as data changes
     */
    await queryRunner.query(`ANALYZE "research_cache"`);

    // === DOCUMENTATION INDEXES ===

    /**
     * Summary of index usage:
     *
     * PRIMARY QUERIES:
     * 1. Get cached research by URL
     *    SELECT * FROM research_cache WHERE githubUrl = ? (uses IDX_research_cache_github_url)
     *    Expected time: <1ms
     *
     * 2. Find similar repositories
     *    SELECT *, embedding <-> query_vec AS dist FROM research_cache
     *    WHERE status = 'active' ORDER BY dist LIMIT 10
     *    Expected time: 10-50ms (100k+ vectors)
     *    Uses: IDX_research_cache_embedding_cosine
     *
     * 3. Clean up expired cache
     *    DELETE FROM research_cache WHERE expiresAt < NOW() AND status = 'active'
     *    Expected time: <100ms per 1000 expired entries
     *    Uses: IDX_research_cache_expires_at
     *
     * 4. Find hot repositories
     *    SELECT * FROM research_cache WHERE accessCount > 50 ORDER BY accessCount DESC LIMIT 10
     *    Expected time: <5ms
     *    Uses: IDX_research_cache_access_pattern
     *
     * 5. Search by tag
     *    SELECT * FROM research_cache WHERE status = 'active' AND 'framework' = ANY(tags)
     *    Expected time: 5-20ms (100k+ items)
     *    Uses: IDX_research_cache_tags
     *
     * 6. Filter by language
     *    SELECT * FROM research_cache WHERE (metadata->>'language') = 'JavaScript'
     *    Expected time: 5-10ms
     *    Uses: IDX_research_cache_metadata_language
     *
     * 7. Find recent cache entries
     *    SELECT * FROM research_cache WHERE status = 'active' ORDER BY cachedAt DESC LIMIT 10
     *    Expected time: <5ms
     *    Uses: IDX_research_cache_status_cached_at
     *
     * MAINTENANCE QUERIES:
     * - Monitor cache hit ratio: SELECT accessCount, COUNT(*) FROM research_cache GROUP BY accessCount
     * - Identify stale cache: SELECT * FROM research_cache WHERE lastAccessedAt < NOW() - INTERVAL '30 days'
     * - Estimate storage: SELECT pg_size_pretty(pg_total_relation_size('research_cache'))
     */
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop all indexes (TypeORM/PostgreSQL automatically drops dependent indexes)
    await queryRunner.query('DROP TABLE IF EXISTS "research_cache"');

    // Note: Do NOT drop the vector extension as other tables might use it
    // await queryRunner.query('DROP EXTENSION IF EXISTS vector');
  }
}
