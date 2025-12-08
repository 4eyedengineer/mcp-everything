import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  Index,
} from 'typeorm';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255, unique: true })
  @Index('IDX_users_email')
  email: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  passwordHash?: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  firstName?: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  lastName?: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  githubUsername?: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  @Index('IDX_users_githubId')
  githubId?: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  @Index('IDX_users_googleId')
  googleId?: string;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @Column({ type: 'boolean', default: false })
  isEmailVerified: boolean;

  @Column({ type: 'varchar', length: 20, default: 'free' })
  @Index('IDX_users_tier')
  tier: 'free' | 'pro' | 'enterprise';

  @Column({ type: 'timestamp', nullable: true })
  lastLoginAt?: Date;

  @Column({ type: 'varchar', length: 255, nullable: true })
  passwordResetTokenHash?: string;

  @Column({ type: 'timestamp', nullable: true })
  passwordResetExpiresAt?: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
