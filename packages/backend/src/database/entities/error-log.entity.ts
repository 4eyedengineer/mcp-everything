import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index } from 'typeorm';

/**
 * ErrorLog Entity
 *
 * Persists all application errors to the database for debugging and analysis.
 * Provides a queryable history of errors with context for easier debugging.
 */
@Entity('error_logs')
export class ErrorLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'timestamp' })
  @Index('IDX_error_logs_timestamp')
  timestamp: Date;

  @Column({ type: 'varchar', length: 50 })
  @Index('IDX_error_logs_level')
  level: 'error' | 'warn' | 'fatal';

  @Column({ type: 'varchar', length: 500 })
  message: string;

  @Column({ type: 'text', nullable: true })
  stack?: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  @Index('IDX_error_logs_service')
  service?: string;  // e.g., 'GraphService', 'ResearchService'

  @Column({ type: 'varchar', length: 255, nullable: true })
  method?: string;   // e.g., 'analyzeIntent', 'runResearch'

  @Column({ type: 'uuid', nullable: true })
  @Index('IDX_error_logs_conversationId')
  conversationId?: string;

  @Column({ type: 'uuid', nullable: true })
  @Index('IDX_error_logs_userId')
  userId?: string;

  @Column({ type: 'jsonb', nullable: true })
  context?: Record<string, any>;  // Additional context (request body, state, etc.)

  @Column({ type: 'varchar', length: 100, nullable: true })
  @Index('IDX_error_logs_errorCode')
  errorCode?: string;  // Custom error codes for categorization

  @Column({ type: 'boolean', default: false })
  @Index('IDX_error_logs_resolved')
  resolved: boolean;

  @Column({ type: 'text', nullable: true })
  resolution?: string;  // How was this fixed?

  @CreateDateColumn()
  createdAt: Date;
}
