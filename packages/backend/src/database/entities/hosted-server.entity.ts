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

@Entity('hosted_servers')
export class HostedServer {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'conversation_id', type: 'uuid', nullable: true })
  conversationId: string;

  @ManyToOne(() => Conversation, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'conversation_id' })
  conversation: Conversation;

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string;

  // Server identification
  @Column({ name: 'server_name', length: 100 })
  serverName: string;

  @Index()
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
  @Index()
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
