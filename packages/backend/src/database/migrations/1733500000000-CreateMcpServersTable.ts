import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateMcpServersTable1733500000000 implements MigrationInterface {
  name = 'CreateMcpServersTable1733500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE mcp_servers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(100) NOT NULL,
        slug VARCHAR(200) NOT NULL UNIQUE,
        description TEXT NOT NULL,
        long_description TEXT,
        category VARCHAR(50) NOT NULL,
        tags TEXT[],
        visibility VARCHAR(20) DEFAULT 'public'
          CHECK (visibility IN ('public', 'private', 'unlisted')),
        author_id UUID REFERENCES users(id) ON DELETE SET NULL,
        repository_url VARCHAR(500),
        gist_url VARCHAR(500),
        download_url VARCHAR(500),
        tools JSONB,
        resources JSONB,
        env_vars TEXT[],
        language VARCHAR(20) DEFAULT 'typescript'
          CHECK (language IN ('typescript', 'python', 'javascript')),
        download_count INTEGER DEFAULT 0,
        view_count INTEGER DEFAULT 0,
        rating NUMERIC(2,1) DEFAULT 0,
        rating_count INTEGER DEFAULT 0,
        status VARCHAR(20) DEFAULT 'pending'
          CHECK (status IN ('pending', 'approved', 'rejected', 'archived')),
        featured BOOLEAN DEFAULT false,
        source_conversation_id UUID,
        metadata JSONB,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        published_at TIMESTAMP
      );

      -- Indexes for common queries
      CREATE INDEX idx_mcp_servers_name ON mcp_servers(name);
      CREATE INDEX idx_mcp_servers_slug ON mcp_servers(slug);
      CREATE INDEX idx_mcp_servers_category ON mcp_servers(category);
      CREATE INDEX idx_mcp_servers_visibility ON mcp_servers(visibility);
      CREATE INDEX idx_mcp_servers_status ON mcp_servers(status);
      CREATE INDEX idx_mcp_servers_author_id ON mcp_servers(author_id);
      CREATE INDEX idx_mcp_servers_featured ON mcp_servers(featured);
      CREATE INDEX idx_mcp_servers_downloads ON mcp_servers(download_count DESC);
      CREATE INDEX idx_mcp_servers_rating ON mcp_servers(rating DESC);
      CREATE INDEX idx_mcp_servers_created_at ON mcp_servers(created_at DESC);

      -- GIN index for tags array search
      CREATE INDEX idx_mcp_servers_tags ON mcp_servers USING gin(tags);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS mcp_servers');
  }
}
