-- MCP Everything Database Initialization
-- This script runs automatically when PostgreSQL container first starts

-- Create extensions (if needed)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Enable pgvector extension for vector similarity search
-- Required for research-cache.entity.ts embedding column (vector(384))
-- See: https://github.com/pgvector/pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- Verify pgvector installation
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
        RAISE NOTICE 'pgvector extension installed successfully';
    ELSE
        RAISE EXCEPTION 'pgvector extension failed to install';
    END IF;
END $$;

-- Note: Table creation is handled by TypeORM migrations
-- This file is for any additional PostgreSQL initialization

-- Grant permissions (for development)
GRANT ALL PRIVILEGES ON DATABASE mcp_everything TO postgres;

-- Log initialization
DO $$
BEGIN
    RAISE NOTICE 'MCP Everything database initialized successfully';
END $$;
