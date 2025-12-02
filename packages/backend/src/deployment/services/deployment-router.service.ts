import { Injectable, Logger, ForbiddenException, Inject, forwardRef } from '@nestjs/common';
import { UserService } from '../../user/user.service';
import { DeploymentOrchestratorService } from '../deployment.service';
import { DeploymentResult, DeploymentOptions, EnterpriseDeploymentOptions } from '../types/deployment.types';
import { UserTier, TIER_CONFIG, TIER_DISPLAY_NAMES } from '../../subscription/tier-config';

export interface TierRestrictedDeploymentOptions extends DeploymentOptions {
  deploymentType?: 'gist' | 'repo' | 'enterprise';
  // Enterprise-specific options
  customDomain?: string;
  region?: string;
  enableCdn?: boolean;
}

export interface DeploymentLimitError {
  code: 'LIMIT_EXCEEDED' | 'TIER_RESTRICTION' | 'USER_NOT_FOUND';
  message: string;
  currentUsage?: number;
  limit?: number;
  currentTier?: string;
  requiredTier?: string;
  upgradeUrl: string;
}

@Injectable()
export class DeploymentRouterService {
  private readonly logger = new Logger(DeploymentRouterService.name);

  constructor(
    private readonly userService: UserService,
    @Inject(forwardRef(() => DeploymentOrchestratorService))
    private readonly deploymentService: DeploymentOrchestratorService,
  ) {}

  async routeDeployment(
    userId: string,
    conversationId: string,
    options: TierRestrictedDeploymentOptions = {},
  ): Promise<DeploymentResult> {
    // 1. Get user and their tier
    const user = await this.userService.findById(userId);
    if (!user) {
      throw new ForbiddenException({
        code: 'USER_NOT_FOUND',
        message: 'User not found',
        upgradeUrl: '/account',
      } as DeploymentLimitError);
    }

    const tierConfig = TIER_CONFIG[user.tier as UserTier];
    this.logger.log(`Routing deployment for user ${userId} (tier: ${user.tier})`);

    // 2. Check usage limits
    const canDeploy = await this.userService.checkCanDeploy(userId);
    if (!canDeploy.allowed) {
      throw new ForbiddenException({
        code: 'LIMIT_EXCEEDED',
        message: canDeploy.reason,
        currentUsage: canDeploy.usage?.serversDeployedThisMonth,
        limit: canDeploy.usage?.monthlyLimit,
        currentTier: user.tier,
        upgradeUrl: '/account?upgrade=true',
      } as DeploymentLimitError);
    }

    // 3. Determine deployment type
    const requestedType = options.deploymentType || this.getDefaultDeploymentType(user.tier as UserTier);

    // 4. Validate deployment type for tier
    if (!tierConfig.deploymentTypes.includes(requestedType)) {
      const requiredTier = this.getRequiredTierForDeploymentType(requestedType);
      throw new ForbiddenException({
        code: 'TIER_RESTRICTION',
        message: `${this.formatDeploymentType(requestedType)} deployment requires ${TIER_DISPLAY_NAMES[requiredTier]} tier or higher`,
        currentTier: user.tier,
        requiredTier,
        upgradeUrl: '/account?upgrade=true',
      } as DeploymentLimitError);
    }

    // 5. Apply tier-specific options
    const deployOptions: DeploymentOptions = {
      ...options,
      // Free tier: always public gists
      isPrivate: tierConfig.privateRepos ? (options.isPrivate ?? true) : false,
    };

    // 6. Execute deployment based on type
    let result: DeploymentResult;
    try {
      switch (requestedType) {
        case 'gist':
          result = await this.deploymentService.deployToGist(conversationId, deployOptions);
          break;
        case 'repo':
          result = await this.deploymentService.deployToGitHub(conversationId, deployOptions);
          break;
        case 'enterprise':
          const enterpriseOptions: EnterpriseDeploymentOptions = {
            customDomain: options.customDomain,
            region: options.region,
            enableCdn: options.enableCdn,
          };
          result = await this.deploymentService.deployToEnterprise(conversationId, enterpriseOptions);
          break;
        default:
          result = await this.deploymentService.deployToGist(conversationId, deployOptions);
      }
    } catch (error) {
      this.logger.error(`Deployment failed for user ${userId}: ${error.message}`);
      throw error;
    }

    // 7. Increment usage on success
    if (result.success) {
      await this.userService.incrementUsage(userId);
      this.logger.log(`Deployment successful, incremented usage for user ${userId}`);
    }

    return result;
  }

  async checkDeploymentPermission(
    userId: string,
    deploymentType: 'gist' | 'repo' | 'enterprise',
  ): Promise<{ allowed: boolean; error?: DeploymentLimitError }> {
    const user = await this.userService.findById(userId);
    if (!user) {
      return {
        allowed: false,
        error: {
          code: 'USER_NOT_FOUND',
          message: 'User not found',
          upgradeUrl: '/account',
        },
      };
    }

    const tierConfig = TIER_CONFIG[user.tier as UserTier];

    // Check usage limits
    const canDeploy = await this.userService.checkCanDeploy(userId);
    if (!canDeploy.allowed) {
      return {
        allowed: false,
        error: {
          code: 'LIMIT_EXCEEDED',
          message: canDeploy.reason!,
          currentUsage: canDeploy.usage?.serversDeployedThisMonth,
          limit: canDeploy.usage?.monthlyLimit,
          currentTier: user.tier,
          upgradeUrl: '/account?upgrade=true',
        },
      };
    }

    // Check deployment type permission
    if (!tierConfig.deploymentTypes.includes(deploymentType)) {
      const requiredTier = this.getRequiredTierForDeploymentType(deploymentType);
      return {
        allowed: false,
        error: {
          code: 'TIER_RESTRICTION',
          message: `${this.formatDeploymentType(deploymentType)} deployment requires ${TIER_DISPLAY_NAMES[requiredTier]} tier or higher`,
          currentTier: user.tier,
          requiredTier,
          upgradeUrl: '/account?upgrade=true',
        },
      };
    }

    return { allowed: true };
  }

  private getDefaultDeploymentType(tier: UserTier): 'gist' | 'repo' | 'enterprise' {
    switch (tier) {
      case UserTier.ENTERPRISE:
        return 'repo';
      case UserTier.PRO:
        return 'repo';
      default:
        return 'gist';
    }
  }

  private getRequiredTierForDeploymentType(deploymentType: string): UserTier {
    switch (deploymentType) {
      case 'enterprise':
        return UserTier.ENTERPRISE;
      case 'repo':
        return UserTier.PRO;
      default:
        return UserTier.FREE;
    }
  }

  private formatDeploymentType(type: string): string {
    switch (type) {
      case 'gist':
        return 'GitHub Gist';
      case 'repo':
        return 'Private Repository';
      case 'enterprise':
        return 'Enterprise';
      default:
        return type;
    }
  }
}
