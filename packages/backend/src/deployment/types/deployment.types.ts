/**
 * Deployment Types
 *
 * TypeScript interfaces for the deployment module.
 */

export type DeploymentType = 'gist' | 'repo' | 'none';
export type DeploymentStatus = 'pending' | 'success' | 'failed';

export interface DeploymentFile {
  path: string;
  content: string;
}

export interface DeploymentUrls {
  repository?: string;
  gist?: string;
  codespace?: string;
  clone?: string;
}

export interface DeploymentOptions {
  isPrivate?: boolean;
  description?: string;
  includeDevContainer?: boolean;
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
