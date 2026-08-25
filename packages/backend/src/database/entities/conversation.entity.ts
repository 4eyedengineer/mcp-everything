import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { User } from './user.entity';

@Entity('conversations')
export class Conversation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: true })
  @Index('IDX_conversations_userId')
  userId?: string;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'userId', foreignKeyConstraintName: 'conversations_userId_fkey' })
  user?: User;

  @Column({ type: 'varchar', length: 255 })
  @Index('IDX_conversations_sessionId')
  sessionId: string;

  @Column({ type: 'jsonb' })
  messages: Array<{
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: Date;
    /**
     * Optional per-message payload, set on the assistant's generation-complete
     * message. Stored inline in this jsonb column (no separate migration
     * needed - jsonb already accepts arbitrary extra keys per element).
     *
     * This is what makes the generated server's Deploy/Download actions and
     * validation badge survive a page reload: previously they only ever
     * existed in the one-shot SSE `complete` event and vanished once history
     * was reloaded from GET /conversations/:id/messages.
     */
    metadata?: {
      generatedCode?: any;
      validation?: {
        success: boolean;
        buildSuccess: boolean;
        toolsFound: number;
        toolsPassedCount: number;
        iterations: number;
      };
    };
  }>;

  @Column({ type: 'jsonb', nullable: true })
  state: {
    currentNode?: string;
    intent?: string;
    extractedData?: Record<string, any>;
    metadata?: Record<string, any>;
    // FIX #128: Add fields for generated code state sync
    generatedCode?: any;
    serverName?: string;
    /**
     * Projection of `generatedCode.metadata.tools` written by
     * GenerationPipeline.syncGeneratedCodeToConversation. `inputSchema` is the
     * tool's JSON Schema; it is optional because rows written before that
     * projection forwarded it - and tools generated without a schema - have no
     * such key.
     */
    tools?: Array<{ name: string; description: string; inputSchema?: any }>;
    [key: string]: any; // Allow additional dynamic properties
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
