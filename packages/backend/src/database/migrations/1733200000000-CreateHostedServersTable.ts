import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateHostedServersTable1733200000000 implements MigrationInterface {
  name = 'CreateHostedServersTable1733200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE hosted_servers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
        user_id UUID,  -- For future auth integration

        -- Server identification
        server_name VARCHAR(100) NOT NULL,
        server_id VARCHAR(50) UNIQUE NOT NULL,  -- URL-safe ID: stripe-abc123
        description TEXT,

        -- Container info
        docker_image VARCHAR(255) NOT NULL,
        image_tag VARCHAR(100) DEFAULT 'latest',

        -- K8s info
        k8s_namespace VARCHAR(100) DEFAULT 'mcp-servers',
        k8s_deployment_name VARCHAR(100),

        -- Endpoint
        endpoint_url TEXT NOT NULL,

        -- Status tracking
        status VARCHAR(20) DEFAULT 'pending'
          CHECK (status IN ('pending', 'building', 'pushing', 'deploying', 'running', 'stopped', 'failed', 'deleted')),
        status_message TEXT,
        last_status_change TIMESTAMP DEFAULT NOW(),

        -- Usage tracking
        request_count INTEGER DEFAULT 0,
        last_request_at TIMESTAMP,

        -- Lifecycle timestamps
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        deployed_at TIMESTAMP,
        stopped_at TIMESTAMP,
        deleted_at TIMESTAMP,

        -- Metadata (JSONB for flexibility)
        tools JSONB,           -- Array of tool definitions
        env_var_names JSONB,   -- Required env var names (not values!)
        config JSONB           -- Additional configuration
      );

      -- Indexes
      CREATE INDEX idx_hosted_servers_server_id ON hosted_servers(server_id);
      CREATE INDEX idx_hosted_servers_status ON hosted_servers(status);
      CREATE INDEX idx_hosted_servers_user_id ON hosted_servers(user_id);
      CREATE INDEX idx_hosted_servers_conversation_id ON hosted_servers(conversation_id);
      CREATE INDEX idx_hosted_servers_created_at ON hosted_servers(created_at DESC);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS hosted_servers`);
  }
}
