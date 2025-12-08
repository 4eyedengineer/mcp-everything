import {
  Controller,
  Get,
  Post,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { SubscriptionService } from './subscription.service';
import { UserService } from '../user/user.service';
import { CreateCheckoutDto, SubscriptionDto, UsageDto, TierInfoDto } from './dto/subscription.dto';
import { TIER_CONFIG, UserTier } from './tier-config';
import { User } from '../database/entities/user.entity';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

@Controller('api/subscription')
export class SubscriptionController {
  constructor(
    private readonly subscriptionService: SubscriptionService,
    private readonly userService: UserService,
  ) {}

  @Get()
  async getSubscription(@CurrentUser() user: User): Promise<SubscriptionDto> {
    const subscription = await this.subscriptionService.getActiveSubscription(user.id);
    return {
      tier: (user.tier as 'free' | 'pro' | 'enterprise') || 'free',
      status: subscription?.status || 'active',
      currentPeriodStart: subscription?.currentPeriodStart,
      currentPeriodEnd: subscription?.currentPeriodEnd,
      cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd || false,
    };
  }

  @Get('tier')
  async getTierInfo(@CurrentUser() user: User): Promise<TierInfoDto> {
    const usage = await this.userService.getCurrentUsage(user.id);
    const tierConfig = TIER_CONFIG[(user.tier as UserTier) || UserTier.FREE];

    return {
      currentTier: (user.tier as 'free' | 'pro' | 'enterprise') || 'free',
      limits: {
        monthlyServerLimit: tierConfig.monthlyServerLimit === Infinity ? 999999 : tierConfig.monthlyServerLimit,
        privateRepos: tierConfig.privateRepos,
        ciCd: tierConfig.ciCd,
        customDomains: tierConfig.customDomains,
        sla: tierConfig.sla,
        prioritySupport: tierConfig.prioritySupport,
      },
      usage: {
        serversDeployed: usage.serversDeployedThisMonth,
        limit: usage.monthlyLimit,
        periodEnd: usage.periodEnd,
      },
      canUpgrade: user.tier !== UserTier.ENTERPRISE,
    };
  }

  @Get('usage')
  async getUsage(@CurrentUser() user: User): Promise<UsageDto> {
    return this.userService.getUsageStats(user.id);
  }

  @Post('checkout')
  @HttpCode(HttpStatus.OK)
  async createCheckout(
    @CurrentUser() user: User,
    @Body() dto: CreateCheckoutDto,
  ): Promise<{ sessionId: string; url: string }> {
    return this.subscriptionService.createCheckoutSession(
      user.id,
      dto.tier,
      dto.interval || 'monthly',
    );
  }

  @Post('portal')
  @HttpCode(HttpStatus.OK)
  async createPortal(@CurrentUser() user: User): Promise<{ url: string }> {
    return this.subscriptionService.createPortalSession(user.id);
  }
}
