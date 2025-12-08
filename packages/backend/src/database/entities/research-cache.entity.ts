import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { GraphState } from '../../orchestration/types';

/**
 * Research Cache Entity
 *
 * Stores research results with:
 * - 7-day TTL for automatic expiration
 * - Vector embeddings for semantic similarity search
 * - Complex nested JSON data (ResearchPhase object)
 * - Access pattern tracking for optimization
 * - Knowledge graph relationships via github URL
 *
 * Performance Characteristics:
 * - URL lookup: O(1) via B-tree index on githubUrl
 * - TTL cleanup: O(log n) via partial index on expiresAt
 * - Vector similarity: O(k) via IVFFlat indexing with pgvector
 * - Range queries: O(log n) via composite indexes
 *
 * Storage: ~2-5KB per cached research item (before compression)
 * Expected growth: ~50-100MB per 100k repositories cached
 */
@Entity('research_cache')
@Index('IDX_research_cache_github_url', ['githubUrl'], { unique: true })
@Index('IDX_research_cache_expires_at', ['expiresAt'])
@Index('IDX_research_cache_access_count', ['accessCount'], { where: '"accessCount" > 10' })
@Index('IDX_research_cache_cached_at', ['cachedAt'], { where: 'NOW() - "cachedAt" < interval \'7 days\'' })
export class ResearchCache {
  /**
   * Primary key: UUID
   * - Distributed ID generation compatible
   * - Allows for horizontal partitioning by ID
   */
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * GitHub repository URL (normalized)
   * - UNIQUE index for fast lookups
   * - Normalized format: https://github.com/owner/repo
   * - Used as cache key for deduplication
   *
   * Examples:
   * - https://github.com/vercel/next.js
   * - https://github.com/oven-sh/bun
   */
  @Column({ type: 'varchar', length: 512 })
  githubUrl: string;

  /**
   * Complete research phase data
   * - Stores WebSearchFindings, DeepGitHubAnalysis, ApiDocAnalysis, SynthesizedPlan
   * - JSONB type for efficient querying and indexing
   * - Compressed at rest via PostgreSQL compression
   *
   * Structure:
   * {
   *   webSearchFindings: { queries, results, patterns, bestPractices },
   *   githubDeepDive: { basicInfo, codeExamples, testPatterns, apiUsagePatterns, dependencies },
   *   apiDocumentation?: { endpoints, authentication, rateLimit },
   *   synthesizedPlan: { summary, keyInsights, recommendedApproach, potentialChallenges, confidence },
   *   researchConfidence: number (0-1),
   *   researchIterations: number
   * }
   */
  @Column({ type: 'jsonb' })
  researchData: GraphState['researchPhase'];

  /**
   * Vector embedding for semantic similarity search
   * - 384-dimensional embedding (from all-MiniLM-L6-v2 or similar)
   * - Generated from synthesized research summary
   * - Enables "find similar repositories" queries
   * - Uses pgvector extension: CREATE EXTENSION IF NOT EXISTS vector;
   *
   * Performance:
   * - IVFFlat index: ~50x faster than sequential scan
   * - Query time: ~10-50ms for 100k vectors
   * - Index size: ~1-2% of data size
   *
   * Index creation (in migration):
   * CREATE INDEX ON research_cache USING ivfflat (embedding vector_cosine_ops)
   * WITH (lists = 100);
   *
   * Example query:
   * SELECT *, embedding <-> query_vector AS distance
   * FROM research_cache
   * WHERE embedding <-> query_vector < 0.3
   * ORDER BY embedding <-> query_vector
   * LIMIT 10;
   */
  @Column({ type: 'vector', length: 384, nullable: true })
  embedding?: number[];

  /**
   * Access count for cache hit optimization
   * - Incremented on cache hits
   * - Used to identify hot repositories
   * - Partitions index between frequently/infrequently accessed
   * - Useful for cache replacement policy
   *
   * Strategy:
   * - High access (>100): Keep for 14 days
   * - Medium access (10-100): Keep for 7 days (default)
   * - Low access (<10): Keep for 3 days
   */
  @Column({ type: 'integer', default: 0 })
  accessCount: number;

  /**
   * Repository metadata cache
   * - Stores basic repo info for quick filtering
   * - Reduces need to parse full researchData
   *
   * Structure:
   * {
   *   name: string,
   *   owner: string,
   *   language: string,
   *   stars: number,
   *   topics: string[],
   *   lastUpdated: Date
   * }
   *
   * Indexed fields can be extracted for faster queries:
   * CREATE INDEX IDX_research_cache_language ON research_cache ((metadata->>'language'));
   * CREATE INDEX IDX_research_cache_stars ON research_cache (((metadata->>'stars')::integer));
   */
  @Column({ type: 'jsonb', nullable: true })
  metadata?: {
    name: string;
    owner: string;
    language: string;
    stars: number;
    topics: string[];
    lastUpdated: Date;
  };

  /**
   * Related repositories (knowledge graph)
   * - Stores IDs of similar/dependent repositories
   * - Enables "repositories that depend on this" queries
   * - Maintains bidirectional relationships
   *
   * Example:
   * {
   *   relatedRepositories: [
   *     { id: 'uuid1', reason: 'depends_on', similarity: 0.87 },
   *     { id: 'uuid2', reason: 'similar_tools', similarity: 0.72 }
   *   ]
   * }
   *
   * This allows:
   * - Find ecosystem of related tools
   * - Recommend repositories to analyze together
   * - Build knowledge graph of MCP-compatible tools
   */
  @Column({ type: 'jsonb', nullable: true })
  relationships?: Array<{
    repositoryId: string;
    relationship: 'depends_on' | 'similar_tools' | 'framework' | 'alternative';
    similarity: number; // 0-1 confidence score
    source: 'embedding' | 'manual' | 'api_analysis';
  }>;

  /**
   * Cache creation timestamp
   * - Set automatically on insert
   * - Used for TTL calculation and access patterns
   * - Indexed for time-range queries
   */
  @CreateDateColumn()
  cachedAt: Date;

  /**
   * Cache expiration timestamp
   * - Set to createdAt + 7 days
   * - Partial index for faster cleanup queries
   * - Used for automatic garbage collection
   *
   * TTL Strategy:
   * - Default: 7 days
   * - Adaptive: Can extend based on accessCount
   * - Cleanup: Run daily DELETE WHERE expiresAt < NOW()
   *
   * Example partial index (in migration):
   * CREATE INDEX IDX_research_cache_cleanup
   * ON research_cache (expiresAt)
   * WHERE expiresAt < NOW();
   */
  @Column({ type: 'timestamp with time zone' })
  expiresAt: Date;

  /**
   * Last access timestamp
   * - Updated on each cache hit
   * - Enables "stale cache" detection
   * - Used for monitoring cache freshness
   *
   * Application logic:
   * - If (now - lastAccessedAt) > 30 days: flag for deletion
   * - If accessCount = 0: can be deleted immediately
   */
  @Column({ type: 'timestamp with time zone', nullable: true })
  lastAccessedAt?: Date;

  /**
   * Record update timestamp
   * - Updated automatically on any change
   * - Tracks when cache entry was last refreshed
   */
  @UpdateDateColumn()
  updatedAt: Date;

  /**
   * Cache status
   * - active: Normal cache state
   * - expired: Past expiration, should be deleted
   * - stale: Old data, should be refreshed
   * - corrupted: Failed to deserialize, flagged for manual review
   */
  @Column({
    type: 'varchar',
    length: 20,
    default: 'active',
    enum: ['active', 'expired', 'stale', 'corrupted'],
  })
  status: 'active' | 'expired' | 'stale' | 'corrupted';

  /**
   * Quality score
   * - Aggregate of research confidence scores
   * - Range: 0-1
   * - Used to prioritize refreshes for low-quality caches
   *
   * Calculation:
   * researchData.researchConfidence * synthesizedPlan.confidence
   */
  @Column({ type: 'numeric', precision: 3, scale: 2, nullable: true })
  qualityScore?: number;

  /**
   * Tags for filtering and organization
   * - Custom tags added during research
   * - Enables multi-dimensional search
   *
   * Examples:
   * - 'web-framework', 'database', 'cli-tool'
   * - 'javascript', 'python', 'go'
   * - 'actively-maintained', 'enterprise', 'starter-kit'
   *
   * Index creation (in migration):
   * CREATE INDEX IDX_research_cache_tags ON research_cache USING gin(tags);
   */
  @Column({ type: 'text', array: true, default: () => 'ARRAY[]::text[]' })
  tags: string[];

  /**
   * Data compression indicator
   * - Tracks if researchData is compressed at column level
   * - PostgreSQL handles JSONB compression automatically
   * - This field documents compression strategy
   */
  @Column({ type: 'varchar', length: 20, default: 'none' })
  compressionMethod: 'none' | 'pgzip' | 'native';
}
