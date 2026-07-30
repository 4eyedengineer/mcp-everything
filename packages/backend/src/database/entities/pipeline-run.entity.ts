import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Conversation } from './conversation.entity';

/**
 * One row per generation-pipeline step execution.
 *
 * This is the observability record the old write-only `conversation_memories`
 * checkpoints never provided: every step of every run is timed, its status is
 * recorded, and failures keep their error text so a run can be reconstructed
 * after the fact.
 */
@Entity('pipeline_runs')
export class PipelineRun {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  @Index('IDX_pipeline_runs_conversationId')
  conversationId: string;

  @ManyToOne(() => Conversation, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'conversationId' })
  conversation?: Conversation;

  /** Pipeline step name, e.g. `analyzeIntent`, `research`, `planTools`. */
  @Column({ type: 'varchar', length: 64 })
  @Index('IDX_pipeline_runs_step')
  step: string;

  /** `running` | `succeeded` | `failed`. */
  @Column({ type: 'varchar', length: 16 })
  status: string;

  @Column({ type: 'timestamp' })
  startedAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  finishedAt?: Date | null;

  @Column({ type: 'integer', nullable: true })
  durationMs?: number | null;

  /** Short human-readable description of what went into the step. */
  @Column({ type: 'text', nullable: true })
  inputSummary?: string | null;

  /** Short human-readable description of what the step produced. */
  @Column({ type: 'text', nullable: true })
  outputSummary?: string | null;

  @Column({ type: 'text', nullable: true })
  error?: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
