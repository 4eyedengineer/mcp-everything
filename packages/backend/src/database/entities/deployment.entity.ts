import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Conversation } from './conversation.entity';
import { User } from './user.entity';

@Entity('deployments')
export class Deployment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  @Index()
  conversationId: string;

  @ManyToOne(() => Conversation, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'conversationId' })
  conversation: Conversation;

  @Column({ type: 'uuid', nullable: true })
  @Index('IDX_deployments_userId')
  userId?: string;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'userId' })
  user?: User;

  @Column({ type: 'varchar', length: 20, nullable: true })
  userTier?: 'free' | 'pro' | 'enterprise';

  @Column({ type: 'varchar', length: 20 })
  deploymentType: 'gist' | 'repo' | 'none';

  @Column({ type: 'text', nullable: true })
  repositoryUrl?: string;

  @Column({ type: 'text', nullable: true })
  gistUrl?: string;

  @Column({ type: 'text', nullable: true })
  codespaceUrl?: string;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  @Index()
  status: 'pending' | 'success' | 'failed';

  @Column({ type: 'text', nullable: true })
  errorMessage?: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, any>;

  @CreateDateColumn()
  createdAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  deployedAt?: Date;

  // Validation fields
  @Column({ type: 'varchar', length: 20, default: 'pending' })
  @Index()
  validationStatus: 'pending' | 'running' | 'passed' | 'failed' | 'skipped';

  @Column({ type: 'timestamp', nullable: true })
  validatedAt?: Date;

  @Column({ type: 'int', nullable: true })
  toolsPassedCount?: number;

  @Column({ type: 'int', nullable: true })
  toolsTestedCount?: number;

  @Column({ type: 'jsonb', nullable: true })
  validationResults?: {
    buildSuccess: boolean;
    buildDuration?: number;
    toolResults: Array<{
      toolName: string;
      success: boolean;
      error?: string;
      executionTime: number;
    }>;
    errors?: string[];
    source: 'local_docker' | 'github_actions' | 'manual';
  };

  @Column({ type: 'varchar', nullable: true })
  workflowRunId?: string;

  // Server metadata for cloud hosting
  @Column({ type: 'varchar', length: 100, nullable: true })
  serverName?: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ type: 'jsonb', nullable: true })
  tools?: Array<{ name: string; description: string; inputSchema: any }>;

  @Column({ type: 'jsonb', nullable: true })
  envVars?: Array<{ name: string; required: boolean; description?: string }>;

  @Column({ type: 'text', nullable: true })
  localPath?: string;
}
