import { Injectable, Logger, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { User } from '../database/entities/user.entity';
import { UsageRecord } from '../database/entities/usage.entity';
import { UserTier, TIER_CONFIG } from '../subscription/tier-config';
import { CreateUserDto, UpdateUserDto } from './dto/user.dto';

@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);
  private readonly SALT_ROUNDS = 10;

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(UsageRecord)
    private readonly usageRepository: Repository<UsageRecord>,
  ) {}

  async findById(id: string): Promise<User | null> {
    return this.userRepository.findOne({ where: { id } });
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.userRepository.findOne({ where: { email: email.toLowerCase() } });
  }

  async findByGithubId(githubId: string): Promise<User | null> {
    return this.userRepository.findOne({ where: { githubId } });
  }

  async findByGoogleId(googleId: string): Promise<User | null> {
    return this.userRepository.findOne({ where: { googleId } });
  }

  async createUser(dto: CreateUserDto): Promise<User> {
    const email = dto.email.toLowerCase();
    const existing = await this.findByEmail(email);
    if (existing) {
      throw new ConflictException('User with this email already exists');
    }

    let passwordHash: string | undefined;
    if (dto.password) {
      passwordHash = await bcrypt.hash(dto.password, this.SALT_ROUNDS);
    }

    const user = this.userRepository.create({
      email,
      passwordHash,
      firstName: dto.firstName,
      lastName: dto.lastName,
      githubId: dto.githubId,
      githubUsername: dto.githubUsername,
      googleId: dto.googleId,
      tier: UserTier.FREE,
    });

    const savedUser = await this.userRepository.save(user);
    this.logger.log(`Created user: ${savedUser.id} (${savedUser.email})`);

    // Create initial usage record
    await this.createUsageRecord(savedUser.id);

    return savedUser;
  }

  async updateUser(userId: string, dto: UpdateUserDto): Promise<User> {
    const user = await this.findById(userId);
    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (dto.firstName !== undefined) user.firstName = dto.firstName;
    if (dto.lastName !== undefined) user.lastName = dto.lastName;
    if (dto.githubUsername !== undefined) user.githubUsername = dto.githubUsername;

    return this.userRepository.save(user);
  }

  async deleteUser(userId: string): Promise<void> {
    const user = await this.findById(userId);
    if (!user) {
      throw new NotFoundException('User not found');
    }

    await this.userRepository.remove(user);
    this.logger.log(`Deleted user: ${userId}`);
  }

  async validatePassword(user: User, password: string): Promise<boolean> {
    if (!user.passwordHash) {
      return false;
    }
    return bcrypt.compare(password, user.passwordHash);
  }

  async linkOAuthAccount(
    userId: string,
    provider: 'github' | 'google',
    providerId: string,
    username?: string,
  ): Promise<User> {
    const user = await this.findById(userId);
    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (provider === 'github') {
      user.githubId = providerId;
      if (username) {
        user.githubUsername = username;
      }
    } else if (provider === 'google') {
      user.googleId = providerId;
    }

    const savedUser = await this.userRepository.save(user);
    this.logger.log(`Linked ${provider} account to user ${userId}`);
    return savedUser;
  }

  async updateLastLogin(userId: string): Promise<void> {
    await this.userRepository.update(userId, { lastLoginAt: new Date() });
  }

  async updateTier(userId: string, tier: UserTier): Promise<User> {
    const user = await this.findById(userId);
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const previousTier = user.tier;
    user.tier = tier;
    const savedUser = await this.userRepository.save(user);

    // Update usage limits based on tier
    const usage = await this.getCurrentUsage(userId);
    const tierConfig = TIER_CONFIG[tier];
    usage.monthlyLimit = tierConfig.monthlyServerLimit === Infinity ? 999999 : tierConfig.monthlyServerLimit;
    await this.usageRepository.save(usage);

    this.logger.log(`Updated user ${userId} tier: ${previousTier} -> ${tier}`);
    return savedUser;
  }

  async getCurrentUsage(userId: string): Promise<UsageRecord> {
    const now = new Date();
    let usage = await this.usageRepository.findOne({
      where: { userId },
      order: { periodEnd: 'DESC' },
    });

    // If no usage record or current period ended, create new one
    if (!usage || usage.periodEnd < now) {
      usage = await this.createUsageRecord(userId);
    }

    return usage;
  }

  async incrementUsage(userId: string): Promise<UsageRecord> {
    const usage = await this.getCurrentUsage(userId);
    usage.serversDeployedThisMonth += 1;
    const saved = await this.usageRepository.save(usage);
    this.logger.log(`Incremented usage for user ${userId}: ${saved.serversDeployedThisMonth}/${saved.monthlyLimit}`);
    return saved;
  }

  async checkCanDeploy(userId: string): Promise<{ allowed: boolean; reason?: string; usage?: UsageRecord }> {
    const user = await this.findById(userId);
    if (!user) {
      return { allowed: false, reason: 'User not found' };
    }

    const tierConfig = TIER_CONFIG[user.tier as UserTier];
    const usage = await this.getCurrentUsage(userId);

    // Pro and Enterprise have unlimited deployments
    if (tierConfig.monthlyServerLimit === Infinity) {
      return { allowed: true, usage };
    }

    if (usage.serversDeployedThisMonth >= tierConfig.monthlyServerLimit) {
      return {
        allowed: false,
        reason: `You have reached your monthly limit of ${tierConfig.monthlyServerLimit} servers. Upgrade to Pro for unlimited deployments.`,
        usage,
      };
    }

    return { allowed: true, usage };
  }

  async resetMonthlyUsage(userId: string): Promise<void> {
    this.logger.log(`Resetting monthly usage for user ${userId}`);
    await this.createUsageRecord(userId);
  }

  async getUsageStats(userId: string): Promise<{
    serversDeployedThisMonth: number;
    monthlyLimit: number;
    periodStart: Date;
    periodEnd: Date;
    percentUsed: number;
    remainingDeployments: number;
  }> {
    const usage = await this.getCurrentUsage(userId);
    const percentUsed = usage.monthlyLimit === 999999
      ? 0
      : Math.round((usage.serversDeployedThisMonth / usage.monthlyLimit) * 100);
    const remainingDeployments = usage.monthlyLimit === 999999
      ? 999999
      : Math.max(0, usage.monthlyLimit - usage.serversDeployedThisMonth);

    return {
      serversDeployedThisMonth: usage.serversDeployedThisMonth,
      monthlyLimit: usage.monthlyLimit,
      periodStart: usage.periodStart,
      periodEnd: usage.periodEnd,
      percentUsed,
      remainingDeployments,
    };
  }

  private async createUsageRecord(userId: string): Promise<UsageRecord> {
    const user = await this.findById(userId);
    const tierConfig = TIER_CONFIG[(user?.tier as UserTier) || UserTier.FREE];

    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    const usage = this.usageRepository.create({
      userId,
      serversDeployedThisMonth: 0,
      monthlyLimit: tierConfig.monthlyServerLimit === Infinity ? 999999 : tierConfig.monthlyServerLimit,
      periodStart,
      periodEnd,
    });

    const saved = await this.usageRepository.save(usage);
    this.logger.log(`Created usage record for user ${userId}: limit=${saved.monthlyLimit}`);
    return saved;
  }
}
