/**
 * Deployment Types
 *
 * TypeScript interfaces for the deployment module.
 */

import { CollectedEnvVar } from '../../types/env-variable.types';

export type DeploymentType = 'gist' | 'repo' | 'enterprise' | 'none';
export type DeploymentStatus = 'pending' | 'success' | 'failed';

export interface DeploymentFile {
  path: string;
  content: string;
}

export interface DeploymentUrls {
  repository?: string;
  gist?: string;
  gistRaw?: string;
  codespace?: string;
  clone?: string;
  enterprise?: string;
}

export interface DeploymentOptions {
  isPrivate?: boolean;
  description?: string;
  includeDevContainer?: boolean;
  /** Environment variables to set as GitHub repository secrets */
  envVars?: CollectedEnvVar[];
}

export interface DeploymentResult {
  success: boolean;
  deploymentId: string;
  type: DeploymentType;
  urls: DeploymentUrls;
  error?: string;
}

export interface DeploymentStatusResponse {
  deploymentId: string;
  conversationId: string;
  type: DeploymentType;
  status: DeploymentStatus;
  urls: DeploymentUrls;
  errorMessage?: string;
  createdAt: Date;
  deployedAt?: Date;
}

export interface GitHubRepoResult {
  success: boolean;
  repositoryUrl?: string;
  cloneUrl?: string;
  codespaceUrl?: string;
  error?: string;
}

export interface GistResult {
  success: boolean;
  gistUrl?: string;
  gistId?: string;
  rawUrl?: string;
  error?: string;
}

export interface DevContainerConfig {
  name: string;
  image: string;
  features: Record<string, unknown>;
  customizations: {
    vscode: {
      extensions: string[];
      settings: Record<string, unknown>;
    };
  };
  postCreateCommand: string;
  remoteUser: string;
}

/**
 * Enterprise deployment options (stub for future implementation)
 */
export interface EnterpriseDeploymentOptions {
  customDomain?: string;
  region?: string;
  enableCdn?: boolean;
}

/**
 * Filters for listing deployments
 */
export interface DeploymentFilters {
  type?: DeploymentType;
  status?: DeploymentStatus;
  limit?: number;
  offset?: number;
}

/**
 * Paginated deployment list result
 */
export interface PaginatedDeployments {
  deployments: DeploymentStatusResponse[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Delete deployment result
 */
export interface DeleteDeploymentResult {
  success: boolean;
  error?: string;
}
