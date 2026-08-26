import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { User } from './user.entity';

/**
 * A secret a user stores in their own vault (e.g. a personal GITHUB_TOKEN or
 * a Stripe key) so it can later be injected into a hosted MCP server they
 * own, without the user ever having to paste it into a deployment form again.
 *
 * The plaintext value is write-only by design: it is accepted once on
 * creation, encrypted at rest via `TokenEncryptionService` (AES-256-GCM),
 * and never returned by any read path (`listCredentials`,
 * `resolveForDeploy`'s caller-facing contract aside - see
 * `CredentialVaultService`). Only `valueEncrypted` holds secret material;
 * every other column is safe to log or display.
 *
 * `name` is the user-facing handle used to reference this credential from a
 * deployment (e.g. "my-github-token"), scoped unique per user so two users
 * (or the same user across servers) can both have a credential named
 * "GITHUB_TOKEN" without collision.
 */
@Entity('user_credentials')
@Index('uq_user_credentials_user_id_name', ['userId', 'name'], { unique: true })
export class UserCredential {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('idx_user_credentials_user_id')
  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'user_credentials_user_id_fkey',
  })
  user: User;

  /** User-facing label/handle for this credential, e.g. "GITHUB_TOKEN". */
  @Column({ type: 'varchar', length: 100 })
  name: string;

  /** Optional free-text note to help the user remember what this is for. */
  @Column({ type: 'varchar', length: 500, nullable: true })
  description: string | null;

  /**
   * AES-256-GCM ciphertext produced by `TokenEncryptionService.encrypt()`.
   * The plaintext is never persisted anywhere and is not recoverable except
   * by decrypting this column with the same `TOKEN_ENCRYPTION_KEY`.
   */
  @Column({ name: 'value_encrypted', type: 'text' })
  valueEncrypted: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  /** Set whenever this credential is resolved for injection into a deploy. */
  @Column({ name: 'last_used_at', type: 'timestamp', nullable: true })
  lastUsedAt: Date | null;
}
