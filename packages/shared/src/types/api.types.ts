// API related types for frontend-backend communication

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: ApiError;
  meta?: ResponseMeta;
}

export interface ApiError {
  code: string;
  message: string;
  details?: string;
  field?: string;
  statusCode?: number;
}

export interface ResponseMeta {
  timestamp: string;
  requestId: string;
  pagination?: PaginationMeta;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrevious: boolean;
}

export interface PaginationParams {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface SearchParams extends PaginationParams {
  query?: string;
  filters?: Record<string, any>;
}

// GitHub API related types
export interface GitHubAnalysisResult {
  repository: {
    name: string;
    fullName: string;
    description: string;
    language: string;
    topics: string[];
    stars: number;
    forks: number;
    openIssues: number;
    lastUpdated: string;
  };
  structure: {
    hasApiEndpoints: boolean;
    frameworks: string[];
    dependencies: string[];
    configFiles: string[];
    documentationFiles: string[];
    testFiles: string[];
  };
  apiEndpoints?: {
    path: string;
    method: string;
    description?: string;
  }[];
  mcpCapabilities: {
    suggestedTools: string[];
    suggestedResources: string[];
    complexity: 'simple' | 'moderate' | 'complex';
    estimatedGenerationTime: number;
  };
}

// Project and Generation API types (updated to match entities)
export interface CreateProjectRequest {
  name: string;
  description?: string;
  type: 'github_repository' | 'api_specification' | 'natural_language' | 'custom_code';
  sourceConfig: {
    repositoryUrl?: string;
    branch?: string;
    specificationUrl?: string;
    description?: string;
    requirements?: string[];
    codeFiles?: { name: string; content: string }[];
  };
}

export interface GenerateServerRequest {
  projectId?: string;
  sourceType: 'github' | 'api-spec' | 'description' | 'github_repository' | 'api_specification' | 'natural_language' | 'custom_code';
  input: string | object;
  options: {
    includeTests: boolean;
    includeDocumentation: boolean;
    targetLanguage: 'typescript' | 'python' | 'go';
    customInstructions?: string;
  };
}

export interface GenerateServerResponse {
  generationId: string;
  estimatedTime: number;
  status: 'started' | 'failed';
}

export interface GenerationStatusResponse {
  id: string;
  status: 'pending' | 'analyzing' | 'generating' | 'building' | 'validating' | 'completed' | 'failed';
  progress: number; // 0-100
  currentStep: string;
  logs: {
    timestamp: string;
    level: 'info' | 'warn' | 'error';
    message: string;
  }[];
  result?: {
    serverId: string;
    deploymentUrl?: string;
    validationResults: {
      passed: boolean;
      errors: string[];
      warnings: string[];
    };
  };
}

// Server management API
export interface ListServersRequest extends SearchParams {
  status?: string;
  sourceType?: string;
}

export interface ServerDetailsResponse {
  id: string;
  name: string;
  description: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  sourceType: string;
  sourceInput: string;
  deploymentUrl?: string;
  tools: {
    name: string;
    description: string;
  }[];
  resources: {
    name: string;
    description: string;
    uri: string;
  }[];
  buildLogs: {
    timestamp: string;
    level: string;
    message: string;
  }[];
}

export interface UpdateServerRequest {
  name?: string;
  description?: string;
  tags?: string[];
}