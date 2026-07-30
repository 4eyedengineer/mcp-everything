import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { User } from './user.entity';

/**
 * A user-generated API key that can authenticate requests as an alternative
 * to a JWT access token (see ApiKeyGuard / JwtAuthGuard).
 *
 * The full key is only ever returned once, at creation time. We persist only
 * a sha256 hash of it (`keyHash`) plus a short `keyPrefix` for display
 * purposes (e.g. "mcpe_a1b2") so users can tell keys apart in the UI.
 */
@Entity('api_keys')
export class ApiKey {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  @Index('IDX_api_keys_userId')
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  /** First 8 chars of the generated key (after the `mcpe_` prefix), for display only. */
  @Column({ type: 'varchar', length: 16 })
  keyPrefix: string;

  /** sha256 hex digest of the full key. The plaintext key is never stored. */
  @Column({ type: 'varchar', length: 64, unique: true })
  @Index('IDX_api_keys_keyHash')
  keyHash: string;

  @Column({ type: 'timestamp', nullable: true })
  lastUsedAt?: Date;

  @CreateDateColumn()
  createdAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  @Index('IDX_api_keys_revokedAt')
  revokedAt?: Date;
}
