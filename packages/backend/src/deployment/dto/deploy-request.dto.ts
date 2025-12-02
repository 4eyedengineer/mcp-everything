import {
  IsString,
  IsUUID,
  IsEnum,
  IsOptional,
  IsBoolean,
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
}

/**
 * Response DTO for deployment operations
 */
export class DeploymentResponseDto {
  success: boolean;
  deploymentId?: string;
  type?: 'gist' | 'repo' | 'none';
  urls?: {
    repository?: string;
    gist?: string;
    codespace?: string;
  };
  error?: string;
}

/**
 * Response DTO for deployment status
 */
export class DeploymentStatusDto {
  deploymentId: string;
  conversationId: string;
  type: 'gist' | 'repo' | 'none';
  status: 'pending' | 'success' | 'failed';
  urls: {
    repository?: string;
    gist?: string;
    codespace?: string;
  };
  errorMessage?: string;
  createdAt: Date;
  deployedAt?: Date;
}
