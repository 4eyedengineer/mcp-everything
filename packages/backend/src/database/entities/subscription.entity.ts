import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from './user.entity';

@Entity('subscriptions')
export class Subscription {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  @Index('IDX_subscriptions_userId')
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ type: 'varchar', length: 255 })
  @Index('IDX_subscriptions_stripeCustomerId')
  stripeCustomerId: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  @Index('IDX_subscriptions_stripeSubscriptionId')
  stripeSubscriptionId?: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  stripePriceId?: string;

  @Column({ type: 'varchar', length: 20, default: 'free' })
  tier: 'free' | 'pro' | 'enterprise';

  @Column({ type: 'varchar', length: 20, default: 'active' })
  @Index('IDX_subscriptions_status')
  status: 'active' | 'canceled' | 'past_due' | 'incomplete' | 'trialing';

  @Column({ type: 'timestamp', nullable: true })
  currentPeriodStart?: Date;

  @Column({ type: 'timestamp', nullable: true })
  currentPeriodEnd?: Date;

  @Column({ type: 'boolean', default: false })
  cancelAtPeriodEnd: boolean;

  @Column({ type: 'timestamp', nullable: true })
  canceledAt?: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
