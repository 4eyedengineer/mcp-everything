import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index, ManyToOne, JoinColumn } from 'typeorm';
import { Conversation } from './conversation.entity';

/**
 * Stores LangGraph checkpoints and memory for conversation state persistence
 */
@Entity('conversation_memories')
export class ConversationMemory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  @Index()
  conversationId: string;

  @ManyToOne(() => Conversation, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'conversationId' })
  conversation: Conversation;

  @Column({ type: 'varchar', length: 255 })
  checkpointId: string;

  @Column({ type: 'jsonb' })
  graphState: Record<string, any>;

  @Column({ type: 'varchar', length: 100 })
  currentNode: string;

  @Column({ type: 'varchar', array: true, default: '{}' })
  executedNodes: string[];

  @Column({ type: 'jsonb', nullable: true })
  toolResults: Array<{
    toolName: string;
    input: any;
    output: any;
    timestamp: Date;
  }>;

  @CreateDateColumn()
  createdAt: Date;

  @Column({ type: 'boolean', default: false })
  isCompleted: boolean;
}
