import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Conversation } from './conversation.entity';

export type HostedServerStatus =
  | 'pending'
  | 'building'
  | 'pushing'
  | 'deploying'
  | 'running'
  | 'stopped'
  | 'failed'
  | 'deleted';

/**
 * Schema drift note (see 1753900010000-FixMcpServersSchemaDrift.ts): the
 * 1733200000000 migration also added a
 * `CHECK (status IN ('pending', ..., 'deleted'))` constraint with no
 * TypeORM representation. Dropped for the same reason documented on
 * McpServer - no other enum-like column in this schema is DB-CHECK-enforced.
 */
@Entity('hosted_servers')
export class HostedServer {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * `idx_hosted_servers_conversation_id` (like the other idx_hosted_servers_*
   * indexes below) was created directly in the 1733200000000 migration for
   * join/lookup performance but was never given a TypeORM @Index - marked
   * synchronize:false to document it without migration:generate proposing to
   * drop it.
   */
  @Index('idx_hosted_servers_conversation_id', { synchronize: false })
  @Column({ name: 'conversation_id', type: 'uuid', nullable: true })
  conversationId: string;

  @ManyToOne(() => Conversation, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'conversation_id',
    foreignKeyConstraintName: 'hosted_servers_conversation_id_fkey',
  })
  conversation: Conversation;

  @Index('idx_hosted_servers_user_id', { synchronize: false })
  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string;

  // Server identification
  @Column({ name: 'server_name', length: 100 })
  serverName: string;

  @Index('idx_hosted_servers_server_id')
  @Column({ name: 'server_id', length: 50, unique: true })
  serverId: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  // Container info
  @Column({ name: 'docker_image', length: 255 })
  dockerImage: string;

  @Column({ name: 'image_tag', length: 100, default: 'latest' })
  imageTag: string;

  // K8s info
  @Column({ name: 'k8s_namespace', length: 100, default: 'mcp-servers' })
  k8sNamespace: string;

  @Column({ name: 'k8s_deployment_name', length: 100, nullable: true })
  k8sDeploymentName: string;

  // Endpoint
  @Column({ name: 'endpoint_url', type: 'text' })
  endpointUrl: string;

  // Status
  @Index('idx_hosted_servers_status')
  @Column({ length: 20, default: 'pending' })
  status: HostedServerStatus;

  @Column({ name: 'status_message', type: 'text', nullable: true })
  statusMessage: string;

  @Column({ name: 'last_status_change', type: 'timestamp', default: () => 'NOW()' })
  lastStatusChange: Date;

  // Usage
  @Column({ name: 'request_count', default: 0 })
  requestCount: number;

  @Column({ name: 'last_request_at', type: 'timestamp', nullable: true })
  lastRequestAt: Date;

  // Lifecycle
  /** See `idx_hosted_servers_conversation_id` above - same reasoning. */
  @Index('idx_hosted_servers_created_at', { synchronize: false })
  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @Column({ name: 'deployed_at', type: 'timestamp', nullable: true })
  deployedAt: Date;

  @Column({ name: 'stopped_at', type: 'timestamp', nullable: true })
  stoppedAt: Date;

  @Column({ name: 'deleted_at', type: 'timestamp', nullable: true })
  deletedAt: Date;

  // Metadata
  @Column({ type: 'jsonb', nullable: true })
  tools: Array<{ name: string; description: string; inputSchema: any }>;

  @Column({ name: 'env_var_names', type: 'jsonb', nullable: true })
  envVarNames: string[];

  @Column({ type: 'jsonb', nullable: true })
  config: Record<string, any>;
}
