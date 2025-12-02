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
}
