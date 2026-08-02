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
 * User intent for a hosted server. Distinct from `HostedServerStatus`, which
 * is the (now derived) legacy display value, and from
 * `HostedServerObservedStatus`, which is what the cluster actually reports.
 */
export type HostedServerDesiredState = 'running' | 'stopped' | 'deleted';

/**
 * Reality as reported by the Kubernetes API. Mirrors `ObservedStatus` in
 * hosting/services/k8s-control-plane.service.ts.
 */
export type HostedServerObservedStatus =
  | 'running'
  | 'progressing'
  | 'stopped'
  | 'degraded'
  | 'failed'
  | 'missing'
  | 'unknown';

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

  // --- Desired vs observed state (migration 1754200000000) ---
  //
  // The single `status` column above conflates two different things: what the
  // user asked for, and what the cluster is actually doing. It was written on
  // git-commit success and then never reconciled, so a CrashLooping pod read
  // 'running' forever.
  //
  // These columns split the two apart WITHOUT removing `status`, which the
  // frontend (hosting-api.service.ts `HostedServerStatus`, the servers list and
  // the deploy-progress component) still reads. `status` is now a derived
  // mirror: K8sReconcilerService recomputes it from (desiredState,
  // observedStatus) on every pass, so the existing UI keeps rendering the exact
  // same union of values it always did while the honest signal lives here.

  /** What the user asked for. Only ever written by HostingService. */
  @Column({ name: 'desired_state', length: 20, default: 'running' })
  desiredState: HostedServerDesiredState;

  /** What the cluster reports. Only ever written by K8sReconcilerService. */
  @Column({ name: 'observed_status', length: 20, nullable: true })
  observedStatus: HostedServerObservedStatus | null;

  /** When the reconciler last successfully observed this server. */
  @Column({ name: 'observed_at', type: 'timestamp', nullable: true })
  observedAt: Date | null;

  /**
   * Real failure reason from the cluster, e.g.
   * "CrashLoopBackOff: back-off 5m0s restarting failed container".
   */
  @Column({ name: 'observed_message', type: 'text', nullable: true })
  observedMessage: string | null;

  /**
   * Real replica counts from the Deployment. Before these existed,
   * HostingController.getServerStatus fabricated them from the status string
   * (`status === 'running' ? 1 : 0`).
   */
  @Column({ name: 'observed_replicas', type: 'int', nullable: true })
  observedReplicas: number | null;

  @Column({ name: 'observed_ready_replicas', type: 'int', nullable: true })
  observedReadyReplicas: number | null;
}
