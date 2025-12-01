-- Research Cache - Common SQL Queries & Operations
-- File: research-cache-queries.sql
-- Purpose: Reference guide for manual database operations and monitoring

-- ============================================================================
-- SECTION 1: SETUP & VERIFICATION
-- ============================================================================

-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;  -- For text similarity (optional)

-- Verify extensions are installed
SELECT
  name,
  default_version,
  installed_version
FROM pg_available_extensions
WHERE name IN ('vector', 'pg_trgm')
ORDER BY name;

-- Check table exists with correct structure
SELECT
  column_name,
  data_type,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_name = 'research_cache'
ORDER BY ordinal_position;

-- Verify all indexes are created
SELECT
  schemaname,
  tablename,
  indexname,
  indexdef
FROM pg_indexes
WHERE tablename = 'research_cache'
ORDER BY indexname;

-- ============================================================================
-- SECTION 2: BASIC OPERATIONS
-- ============================================================================

-- Get cached research by URL
SELECT *
FROM research_cache
WHERE githubUrl = 'https://github.com/vercel/next.js'
  AND status = 'active'
  AND expiresAt > NOW();

-- Get all active cached research
SELECT
  id,
  githubUrl,
  cachedAt,
  expiresAt,
  accessCount,
  qualityScore,
  status
FROM research_cache
WHERE status = 'active'
ORDER BY cachedAt DESC
LIMIT 100;

-- Get cache entry by ID
SELECT * FROM research_cache WHERE id = '550e8400-e29b-41d4-a716-446655440000';

-- ============================================================================
-- SECTION 3: TTL & EXPIRATION MANAGEMENT
-- ============================================================================

-- Find expired cache entries (still in database)
SELECT
  githubUrl,
  expiresAt,
  NOW() - expiresAt as time_expired,
  accessCount,
  qualityScore
FROM research_cache
WHERE expiresAt < NOW()
ORDER BY expiresAt ASC;

-- Count expired entries
SELECT COUNT(*) as expired_count
FROM research_cache
WHERE expiresAt < NOW() AND status = 'active';

-- Delete expired cache entries (TTL cleanup)
DELETE FROM research_cache
WHERE expiresAt < NOW()
  AND status = 'active';

-- Soft delete (mark as expired instead of removing)
UPDATE research_cache
SET status = 'expired',
    expiresAt = NOW()
WHERE githubUrl = 'https://github.com/vercel/next.js';

-- Invalidate all cache for a user's repositories
UPDATE research_cache
SET status = 'expired',
    expiresAt = NOW()
WHERE githubUrl LIKE 'https://github.com/vercel/%';

-- Find cache entries expiring soon (within 24 hours)
SELECT
  githubUrl,
  expiresAt,
  EXTRACT(HOUR FROM expiresAt - NOW()) as hours_until_expiry,
  accessCount
FROM research_cache
WHERE status = 'active'
  AND expiresAt BETWEEN NOW() AND NOW() + INTERVAL '24 hours'
ORDER BY expiresAt ASC;

-- Extend TTL for specific entry (e.g., extend by 7 days)
UPDATE research_cache
SET expiresAt = expiresAt + INTERVAL '7 days'
WHERE id = '550e8400-e29b-41d4-a716-446655440000';

-- ============================================================================
-- SECTION 4: ACCESS PATTERN ANALYSIS
-- ============================================================================

-- Find most accessed repositories (hot cache)
SELECT
  githubUrl,
  accessCount,
  qualityScore,
  cachedAt,
  lastAccessedAt,
  (NOW() - lastAccessedAt) as time_since_access
FROM research_cache
WHERE status = 'active'
  AND accessCount > 0
ORDER BY accessCount DESC
LIMIT 20;

-- Histogram of access patterns
SELECT
  CASE
    WHEN accessCount = 0 THEN '0 (never accessed)'
    WHEN accessCount BETWEEN 1 AND 5 THEN '1-5 (low)'
    WHEN accessCount BETWEEN 6 AND 20 THEN '6-20 (medium)'
    WHEN accessCount BETWEEN 21 AND 100 THEN '21-100 (high)'
    ELSE '100+ (very high)'
  END as access_band,
  COUNT(*) as count,
  AVG(qualityScore) as avg_quality,
  MIN(cachedAt) as oldest_entry
FROM research_cache
WHERE status = 'active'
GROUP BY access_band
ORDER BY count DESC;

-- Find stale cache (not accessed in 30 days)
SELECT
  githubUrl,
  lastAccessedAt,
  NOW() - lastAccessedAt as days_since_access,
  accessCount,
  qualityScore
FROM research_cache
WHERE status = 'active'
  AND (lastAccessedAt IS NULL OR lastAccessedAt < NOW() - INTERVAL '30 days')
ORDER BY lastAccessedAt ASC NULLS FIRST
LIMIT 50;

-- Find cache with zero accesses (since inserted)
SELECT
  githubUrl,
  cachedAt,
  NOW() - cachedAt as age,
  qualityScore
FROM research_cache
WHERE status = 'active'
  AND accessCount = 0
ORDER BY cachedAt DESC
LIMIT 20;

-- ============================================================================
-- SECTION 5: QUALITY SCORE ANALYSIS
-- ============================================================================

-- Quality distribution
SELECT
  CASE
    WHEN qualityScore >= 0.8 THEN '0.8-1.0 (high)'
    WHEN qualityScore >= 0.6 THEN '0.6-0.8 (medium)'
    WHEN qualityScore >= 0.4 THEN '0.4-0.6 (fair)'
    ELSE '<0.4 (low)'
  END as quality_band,
  COUNT(*) as count,
  AVG(accessCount) as avg_access,
  MIN(qualityScore) as min,
  MAX(qualityScore) as max
FROM research_cache
WHERE status = 'active'
GROUP BY quality_band
ORDER BY quality_band DESC;

-- Find low-quality research (likely to be re-researched)
SELECT
  githubUrl,
  qualityScore,
  (researchData->>'researchConfidence')::float as confidence,
  (researchData->'synthesizedPlan'->>'confidence')::float as plan_confidence,
  (researchData->>'researchIterations')::int as iterations
FROM research_cache
WHERE status = 'active'
  AND qualityScore < 0.5
ORDER BY qualityScore ASC;

-- Find high-quality research (candidates for longer TTL)
SELECT
  githubUrl,
  qualityScore,
  expiresAt - NOW() as time_until_expiry,
  accessCount
FROM research_cache
WHERE status = 'active'
  AND qualityScore >= 0.8
ORDER BY qualityScore DESC
LIMIT 20;

-- ============================================================================
-- SECTION 6: TAG-BASED QUERIES
-- ============================================================================

-- Find all unique tags
SELECT
  tag,
  COUNT(*) as usage_count,
  AVG(qualityScore) as avg_quality,
  AVG(accessCount) as avg_access
FROM research_cache,
  UNNEST(tags) as tag
WHERE status = 'active'
GROUP BY tag
ORDER BY usage_count DESC;

-- Find repositories with specific tag
SELECT
  githubUrl,
  tags,
  qualityScore,
  accessCount
FROM research_cache
WHERE status = 'active'
  AND 'framework' = ANY(tags)
ORDER BY qualityScore DESC
LIMIT 20;

-- Find repositories with multiple tags (AND condition)
SELECT
  githubUrl,
  tags,
  qualityScore
FROM research_cache
WHERE status = 'active'
  AND tags @> ARRAY['framework', 'javascript']
ORDER BY qualityScore DESC;

-- Find repositories with any of several tags (OR condition)
SELECT
  githubUrl,
  tags,
  qualityScore
FROM research_cache
WHERE status = 'active'
  AND (tags && ARRAY['cli-tool', 'api-client'])
ORDER BY qualityScore DESC
LIMIT 30;

-- Count repositories by tag
SELECT
  'framework' as tag,
  COUNT(*) as count
FROM research_cache
WHERE status = 'active' AND 'framework' = ANY(tags)
UNION ALL
SELECT
  'database' as tag,
  COUNT(*) as count
FROM research_cache
WHERE status = 'active' AND 'database' = ANY(tags)
UNION ALL
SELECT
  'actively-maintained' as tag,
  COUNT(*) as count
FROM research_cache
WHERE status = 'active' AND 'actively-maintained' = ANY(tags)
ORDER BY count DESC;

-- ============================================================================
-- SECTION 7: METADATA FILTERING
-- ============================================================================

-- Find repositories by language
SELECT
  githubUrl,
  metadata->>'name' as repo_name,
  metadata->>'language' as language,
  (metadata->>'stars')::int as stars,
  qualityScore
FROM research_cache
WHERE status = 'active'
  AND metadata->>'language' = 'TypeScript'
ORDER BY (metadata->>'stars')::int DESC
LIMIT 20;

-- Repositories by language (aggregated)
SELECT
  metadata->>'language' as language,
  COUNT(*) as count,
  AVG((metadata->>'stars')::int) as avg_stars,
  AVG(qualityScore) as avg_quality
FROM research_cache
WHERE status = 'active'
  AND metadata IS NOT NULL
GROUP BY metadata->>'language'
ORDER BY count DESC;

-- Find popular repositories (high stars)
SELECT
  metadata->>'owner' as owner,
  metadata->>'name' as repo_name,
  (metadata->>'stars')::int as stars,
  metadata->>'language' as language,
  qualityScore,
  accessCount
FROM research_cache
WHERE status = 'active'
  AND (metadata->>'stars')::int > 10000
ORDER BY (metadata->>'stars')::int DESC
LIMIT 30;

-- Find repositories by topic
SELECT
  githubUrl,
  metadata->>'name' as repo_name,
  metadata->'topics' as topics
FROM research_cache
WHERE status = 'active'
  AND metadata IS NOT NULL
  AND metadata->'topics' @> '["database"]'::jsonb
ORDER BY (metadata->>'stars')::int DESC
LIMIT 20;

-- Find repositories by owner
SELECT
  githubUrl,
  metadata->>'name' as repo_name,
  (metadata->>'stars')::int as stars,
  qualityScore
FROM research_cache
WHERE status = 'active'
  AND metadata->>'owner' = 'vercel'
ORDER BY (metadata->>'stars')::int DESC;

-- ============================================================================
-- SECTION 8: VECTOR SIMILARITY SEARCH
-- ============================================================================

-- Find similar repositories (cosine similarity)
-- Note: Requires valid 384-dimensional vector
SELECT
  githubUrl,
  embedding <-> '[0.1, 0.2, 0.3, ...]'::vector AS distance,
  qualityScore,
  tags
FROM research_cache
WHERE status = 'active'
  AND embedding <-> '[0.1, 0.2, 0.3, ...]'::vector < 0.3
ORDER BY distance ASC
LIMIT 10;

-- Find repositories within similarity threshold
SELECT
  githubUrl,
  (embedding <-> '[0.5, 0.4, 0.3, ...]'::vector)::float as similarity_distance,
  qualityScore
FROM research_cache
WHERE status = 'active'
  AND embedding <-> '[0.5, 0.4, 0.3, ...]'::vector < 0.25
ORDER BY similarity_distance ASC;

-- Similarity histogram (how many repos in each distance band)
WITH similarity_scores AS (
  SELECT
    githubUrl,
    (embedding <-> '[0.5, 0.4, 0.3, ...]'::vector)::float as distance
  FROM research_cache
  WHERE status = 'active'
    AND embedding IS NOT NULL
)
SELECT
  CASE
    WHEN distance < 0.1 THEN 'very_similar (0-0.1)'
    WHEN distance < 0.2 THEN 'similar (0.1-0.2)'
    WHEN distance < 0.3 THEN 'somewhat_similar (0.2-0.3)'
    WHEN distance < 0.5 THEN 'dissimilar (0.3-0.5)'
    ELSE 'very_dissimilar (>0.5)'
  END as similarity_band,
  COUNT(*) as count
FROM similarity_scores
GROUP BY similarity_band
ORDER BY count DESC;

-- ============================================================================
-- SECTION 9: KNOWLEDGE GRAPH OPERATIONS
-- ============================================================================

-- View relationships for a repository
SELECT
  repositoryId,
  relationship,
  similarity,
  source
FROM research_cache,
  JSONB_TO_RECORDSET(relationships) AS rel(
    repositoryId text,
    relationship text,
    similarity float,
    source text
  )
WHERE githubUrl = 'https://github.com/vercel/next.js'
ORDER BY similarity DESC;

-- Find all repositories related to a specific repo
SELECT DISTINCT
  rc2.githubUrl,
  rel.relationship,
  rel.similarity,
  rc2.qualityScore
FROM research_cache rc1,
  JSONB_TO_RECORDSET(rc1.relationships) AS rel(
    repositoryId text,
    relationship text,
    similarity float,
    source text
  )
JOIN research_cache rc2 ON rc2.id = rel.repositoryId
WHERE rc1.githubUrl = 'https://github.com/vercel/next.js'
  AND rc2.status = 'active'
ORDER BY rel.similarity DESC;

-- Build knowledge graph for framework ecosystem
SELECT
  rc1.githubUrl as source,
  rc2.githubUrl as target,
  rel.relationship,
  rel.similarity
FROM research_cache rc1,
  JSONB_TO_RECORDSET(rc1.relationships) AS rel(
    repositoryId text,
    relationship text,
    similarity float,
    source text
  )
JOIN research_cache rc2 ON rc2.id = rel.repositoryId
WHERE rc1.status = 'active'
  AND rc2.status = 'active'
  AND 'framework' = ANY(rc1.tags)
  AND rel.relationship IN ('similar_tools', 'depends_on')
LIMIT 100;

-- ============================================================================
-- SECTION 10: PERFORMANCE MONITORING
-- ============================================================================

-- Cache statistics summary
SELECT
  COUNT(*) as total_entries,
  SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active_entries,
  SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) as expired_entries,
  SUM(CASE WHEN status = 'stale' THEN 1 ELSE 0 END) as stale_entries,
  SUM(CASE WHEN status = 'corrupted' THEN 1 ELSE 0 END) as corrupted_entries,
  ROUND(AVG(accessCount)::numeric, 2) as avg_access_count,
  MAX(accessCount) as max_access_count,
  ROUND(AVG(qualityScore)::numeric, 4) as avg_quality_score
FROM research_cache;

-- Storage usage
SELECT
  pg_size_pretty(pg_total_relation_size('research_cache')) as total_size,
  pg_size_pretty(pg_relation_size('research_cache')) as table_size,
  pg_size_pretty(pg_indexes_size('research_cache')) as indexes_size,
  ROUND((pg_indexes_size('research_cache')::float /
         pg_total_relation_size('research_cache'))::numeric * 100, 2) as index_overhead_percent;

-- Index usage statistics
SELECT
  indexname,
  idx_scan as scans,
  idx_tup_read as tuples_read,
  idx_tup_fetch as tuples_returned,
  pg_size_pretty(pg_relation_size(indexrelid)) as size,
  CASE
    WHEN idx_scan = 0 THEN 'UNUSED'
    WHEN idx_scan < 10 THEN 'RARELY USED'
    ELSE 'ACTIVE'
  END as status
FROM pg_stat_user_indexes
WHERE tablename = 'research_cache'
ORDER BY idx_scan DESC;

-- Query performance (most expensive scans)
SELECT
  query,
  calls,
  ROUND((total_time::numeric / calls), 2) as avg_time_ms,
  ROUND((total_time::numeric / calls / 1000), 3) as avg_time_sec
FROM pg_stat_statements
WHERE query LIKE '%research_cache%'
ORDER BY total_time DESC
LIMIT 10;

-- ============================================================================
-- SECTION 11: MAINTENANCE & CLEANUP
-- ============================================================================

-- Vacuum and analyze the table
VACUUM ANALYZE research_cache;

-- Reindex all indexes (if performance degrades)
REINDEX TABLE research_cache;

-- Update query planner statistics
ANALYZE research_cache;

-- Estimate space that could be reclaimed
SELECT
  pg_size_pretty(
    CASE WHEN otta > 0 THEN
      cc * ma - (cc * ma - ss) / ma
    ELSE 0
    END::bigint
  ) AS recoverable_space
FROM (
  SELECT
    schemaname, tablename, cc, ma, ss,
    (datawidth + (hdr % ma::int))::int as otta
  FROM (
    SELECT
      schemaname, tablename, hdr, ma, ss,
      SUM((1 - null_frac) * avg_width)::int as datawidth
    FROM pg_stats
    WHERE tablename = 'research_cache'
    GROUP BY schemaname, tablename, hdr, ma, ss
  ) as foo, (
    SELECT 23 AS hdr, 8 AS ma
  ) as settings
) as main;

-- Remove old expired entries permanently
DELETE FROM research_cache
WHERE status = 'expired'
  AND expiresAt < NOW() - INTERVAL '30 days';

-- ============================================================================
-- SECTION 12: BACKUP & DISASTER RECOVERY
-- ============================================================================

-- Export cache as JSON (for backup)
\COPY (
  SELECT json_build_object(
    'id', id,
    'githubUrl', githubUrl,
    'researchData', researchData,
    'metadata', metadata,
    'qualityScore', qualityScore,
    'tags', tags,
    'cachedAt', cachedAt,
    'expiresAt', expiresAt
  )
  FROM research_cache
  WHERE status = 'active'
) TO '/tmp/research_cache_backup.jsonl';

-- Verify backup integrity
SELECT COUNT(*) as backup_entries FROM '/tmp/research_cache_backup.jsonl';

-- Restore from backup (be careful!)
-- This would need custom application logic to parse and restore

-- ============================================================================
-- SECTION 13: COMMON TROUBLESHOOTING QUERIES
-- ============================================================================

-- Check for duplicate URLs (should be 0)
SELECT
  githubUrl,
  COUNT(*) as duplicate_count
FROM research_cache
GROUP BY githubUrl
HAVING COUNT(*) > 1;

-- Check for NULL embeddings (should be few)
SELECT
  COUNT(*) as entries_without_embedding
FROM research_cache
WHERE status = 'active'
  AND embedding IS NULL;

-- Check for corrupted JSON
SELECT
  id,
  githubUrl
FROM research_cache
WHERE status = 'corrupted'
  OR (researchData IS NULL AND status = 'active')
LIMIT 20;

-- Check for mismatched status and expiration
SELECT
  COUNT(*) as mismatches
FROM research_cache
WHERE status != 'active'
  AND expiresAt > NOW();

-- Find cache entries that are very old
SELECT
  githubUrl,
  cachedAt,
  NOW() - cachedAt as age,
  qualityScore,
  accessCount
FROM research_cache
WHERE cachedAt < NOW() - INTERVAL '365 days'
ORDER BY cachedAt ASC;

-- ============================================================================
-- END OF REFERENCE
-- ============================================================================
