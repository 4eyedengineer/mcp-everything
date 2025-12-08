import {
  IsString,
  IsUUID,
  IsOptional,
  IsBoolean,
  IsNumber,
  IsIn,
  Min,
  Max,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Deployment options for customizing the deployment
 */
export class DeploymentOptionsDto {
  @IsOptional()
  @IsBoolean()
  isPrivate?: boolean;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsBoolean()
  includeDevContainer?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  serverName?: string;
}

/**
 * DTO for deploying to GitHub repository
 */
export class DeployToGitHubDto {
  @IsUUID()
  conversationId: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => DeploymentOptionsDto)
  options?: DeploymentOptionsDto;
}

/**
 * DTO for deploying to GitHub Gist
 */
export class DeployToGistDto {
  @IsUUID()
  conversationId: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => DeploymentOptionsDto)
  options?: DeploymentOptionsDto;
}

/**
 * DTO for retrying a failed deployment
 */
export class RetryDeploymentDto {
  @IsUUID()
  deploymentId: string;

  @IsOptional()
  @IsBoolean()
  forceRetry?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  newServerName?: string;
}

/**
 * Response DTO for deployment operations
 */
export class DeploymentResponseDto {
  success: boolean;
  deploymentId?: string;
  type?: 'gist' | 'repo' | 'enterprise' | 'none';
  urls?: {
    repository?: string;
    gist?: string;
    gistRaw?: string;
    codespace?: string;
    enterprise?: string;
  };
  error?: string;
  /** Structured error code for programmatic handling */
  errorCode?: string;
  /** Recommended retry strategy: 'immediate' | 'exponential_backoff' | 'manual' | 'none' */
  retryStrategy?: string;
  /** Milliseconds to wait before retrying (for rate limits) */
  retryAfterMs?: number;
  /** Alternative server names when naming conflict occurs */
  suggestedNames?: string[];
  /** Whether this deployment can be retried */
  canRetry?: boolean;

  // Tier-based limit fields (returned when deployment is blocked)
  /** Current usage count when limit exceeded */
  currentUsage?: number;
  /** Monthly limit for current tier */
  limit?: number;
  /** User's current tier (free, pro, enterprise) */
  currentTier?: string;
  /** Required tier for this deployment type */
  requiredTier?: string;
  /** URL to upgrade subscription */
  upgradeUrl?: string;
}

/**
 * Response DTO for deployment status
 */
export class DeploymentStatusDto {
  deploymentId: string;
  conversationId: string;
  type: 'gist' | 'repo' | 'enterprise' | 'none';
  status: 'pending' | 'success' | 'failed';
  urls: {
    repository?: string;
    gist?: string;
    gistRaw?: string;
    codespace?: string;
    enterprise?: string;
  };
  errorMessage?: string;
  /** Structured error code */
  errorCode?: string;
  /** Number of retry attempts made */
  retryCount?: number;
  /** Whether this deployment can be retried */
  canRetry?: boolean;
  createdAt: Date;
  deployedAt?: Date;
}

/**
 * DTO for updating a Gist deployment
 */
export class UpdateGistDto {
  @IsOptional()
  @IsString()
  description?: string;
}

/**
 * Query DTO for listing deployments with filtering and pagination
 */
export class ListDeploymentsQueryDto {
  @IsOptional()
  @IsIn(['gist', 'repo', 'enterprise'])
  type?: string;

  @IsOptional()
  @IsIn(['pending', 'success', 'failed'])
  status?: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  limit?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  offset?: number;
}

/**
 * Response DTO for paginated deployments list
 */
export class PaginatedDeploymentsDto {
  deployments: DeploymentStatusDto[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Enterprise deployment options (stub for future implementation)
 */
export class EnterpriseOptionsDto {
  @IsOptional()
  @IsString()
  customDomain?: string;

  @IsOptional()
  @IsString()
  region?: string;

  @IsOptional()
  @IsBoolean()
  enableCdn?: boolean;
}

/**
 * DTO for deploying to enterprise (stub for future implementation)
 */
export class DeployToEnterpriseDto {
  @IsUUID()
  conversationId: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => EnterpriseOptionsDto)
  options?: EnterpriseOptionsDto;
}
