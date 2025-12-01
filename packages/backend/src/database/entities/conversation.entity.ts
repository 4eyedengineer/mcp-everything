import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

@Entity('conversations')
export class Conversation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255 })
  @Index()
  sessionId: string;

  @Column({ type: 'jsonb' })
  messages: Array<{
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: Date;
  }>;

  @Column({ type: 'jsonb', nullable: true })
  state: {
    currentNode?: string;
    intent?: string;
    extractedData?: Record<string, any>;
    metadata?: Record<string, any>;
  };

  @Column({ type: 'varchar', length: 100, nullable: true })
  currentStage: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;
}
