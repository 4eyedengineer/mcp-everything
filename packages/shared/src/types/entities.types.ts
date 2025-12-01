// Entity types that mirror the backend database entities
// These can be used by both frontend and backend

export interface UserDto {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  githubUsername?: string;
  isActive: boolean;
  isEmailVerified: boolean;
  lastLoginAt?: string;
  createdAt: string;
  updatedAt: string;
  fullName?: string;
}

export interface ProjectDto {
  id: string;
  name: string;
  description?: string;
  type: ProjectType;
  status: ProjectStatus;
  sourceConfig: ProjectSourceConfig;
  analysisResults?: ProjectAnalysisResults;
  lastGenerationId?: string;
  currentDeploymentUrl?: string;
  generationCount: number;
  successfulGenerations: number;
  createdAt: string;
  updatedAt: string;
  userId: string;
  user?: UserDto;
}

export interface GenerationDto {
  id: string;
  status: GenerationStatus;
  trigger: GenerationTrigger;
  input?: GenerationInput;
  output?: GenerationOutput;
  metadata?: GenerationMetadata;
  errorMessage?: string;
  logs?: string;
  dockerImageTag?: string;
  isValidated: boolean;
  validationScore?: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  projectId: string;
  project?: ProjectDto;
}

export interface DeploymentDto {
  id: string;
  type: DeploymentType;
  status: DeploymentStatus;
  url: string;
  config: DeploymentConfig;
  metadata?: DeploymentMetadata;
  lastHealthCheck?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  deployedAt?: string;
  stoppedAt?: string;
  generationId: string;
  generation?: GenerationDto;
}

// Enum types
export enum ProjectType {
  GITHUB_REPOSITORY = 'github_repository',
  API_SPECIFICATION = 'api_specification',
  NATURAL_LANGUAGE = 'natural_language',
  CUSTOM_CODE = 'custom_code',
}

export enum ProjectStatus {
  DRAFT = 'draft',
  ANALYZING = 'analyzing',
  GENERATING = 'generating',
  BUILDING = 'building',
  DEPLOYING = 'deploying',
  ACTIVE = 'active',
  FAILED = 'failed',
  ARCHIVED = 'archived',
}

export enum GenerationStatus {
  PENDING = 'pending',
  ANALYZING = 'analyzing',
  GENERATING = 'generating',
  BUILDING = 'building',
  VALIDATING = 'validating',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

export enum GenerationTrigger {
  MANUAL = 'manual',
  API = 'api',
  WEBHOOK = 'webhook',
  SCHEDULED = 'scheduled',
}

export enum DeploymentType {
  GIST = 'gist',
  PRIVATE_REPO = 'private_repo',
  ENTERPRISE = 'enterprise',
  VERCEL = 'vercel',
  CLOUD_RUN = 'cloud_run',
}

export enum DeploymentStatus {
  PENDING = 'pending',
  DEPLOYING = 'deploying',
  ACTIVE = 'active',
  FAILED = 'failed',
  STOPPED = 'stopped',
  ARCHIVED = 'archived',
}

// Configuration and nested object types
export interface ProjectSourceConfig {
  repositoryUrl?: string;
  branch?: string;
  accessToken?: string;
  specificationUrl?: string;
  specType?: 'openapi' | 'swagger' | 'postman';
  description?: string;
  requirements?: string[];
  codeFiles?: { name: string; content: string }[];
}

export interface ProjectAnalysisResults {
  fileCount?: number;
  languages?: string[];
  frameworks?: string[];
  dependencies?: string[];
  apiEndpoints?: string[];
  complexity?: 'low' | 'medium' | 'high';
  estimatedBuildTime?: number;
}

export interface GenerationInput {
  analysisResults?: any;
  userInstructions?: string;
  templatePreferences?: string[];
  customizations?: Record<string, any>;
}

export interface GenerationOutput {
  generatedFiles?: { path: string; content: string }[];
  dockerfile?: string;
  packageJson?: any;
  readme?: string;
  mcpManifest?: any;
}

export interface GenerationMetadata {
  llmModel?: string;
  tokensUsed?: number;
  generationTime?: number;
  buildTime?: number;
  validationResults?: any;
  errorDetails?: any;
}

export interface DeploymentConfig {
  gistId?: string;
  visibility?: 'public' | 'private';
  repositoryName?: string;
  repositoryUrl?: string;
  functionUrl?: string;
  region?: string;
  memory?: number;
  timeout?: number;
  environment?: Record<string, string>;
  secrets?: string[];
}

export interface DeploymentMetadata {
  deploymentTime?: number;
  lastHealthCheck?: string;
  healthStatus?: 'healthy' | 'unhealthy' | 'unknown';
  errorDetails?: any;
  logs?: string[];
}