-- MCP Everything Database Initialization
-- This script runs automatically when PostgreSQL container first starts

-- Create extensions (if needed)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Note: Table creation is handled by TypeORM migrations
-- This file is for any additional PostgreSQL initialization

-- Grant permissions (for development)
GRANT ALL PRIVILEGES ON DATABASE mcp_everything TO postgres;

-- Log initialization
DO $$
BEGIN
    RAISE NOTICE 'MCP Everything database initialized successfully';
END $$;
