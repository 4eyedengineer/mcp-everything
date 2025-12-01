// MCP Server related types and interfaces

export interface McpServerConfig {
  id: string;
  name: string;
  description: string;
  version: string;
  author?: string;
  repository?: GitHubRepository;
  createdAt: Date;
  updatedAt: Date;
  status: McpServerStatus;
  deploymentUrl?: string;
  documentation?: string;
  tags: string[];
}

export interface McpServerGeneration {
  id: string;
  sourceType: 'github' | 'api-spec' | 'description';
  sourceInput: string;
  generatedAt: Date;
  generationTimeMs: number;
  llmModel: string;
  status: McpGenerationStatus;
  config: McpServerConfig;
  buildLogs: BuildLog[];
  validationResults: ValidationResult[];
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
  examples?: ToolExample[];
}

export interface McpResource {
  name: string;
  description: string;
  uri: string;
  mimeType?: string;
}

export interface ToolExample {
  name: string;
  description: string;
  input: Record<string, any>;
  expectedOutput?: any;
}

export interface BuildLog {
  id: string;
  timestamp: Date;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  step: BuildStep;
}

export interface ValidationResult {
  id: string;
  type: 'compilation' | 'mcp-protocol' | 'runtime' | 'security';
  status: 'passed' | 'failed' | 'warning';
  message: string;
  details?: string;
  suggestion?: string;
}

export type McpServerStatus =
  | 'draft'
  | 'generating'
  | 'building'
  | 'validating'
  | 'deploying'
  | 'active'
  | 'error'
  | 'archived';

export type McpGenerationStatus =
  | 'pending'
  | 'analyzing'
  | 'generating'
  | 'building'
  | 'validating'
  | 'completed'
  | 'failed';

export type BuildStep =
  | 'analysis'
  | 'code-generation'
  | 'dependency-resolution'
  | 'compilation'
  | 'validation'
  | 'containerization'
  | 'deployment';

export interface GitHubRepository {
  owner: string;
  name: string;
  branch?: string;
  url: string;
  description?: string;
  language?: string;
  topics?: string[];
  stars?: number;
  lastUpdated?: Date;
}

export interface ApiSpecification {
  type: 'openapi' | 'swagger' | 'graphql' | 'postman';
  version: string;
  content: string;
  url?: string;
}

export interface GenerationRequest {
  sourceType: 'github' | 'api-spec' | 'description';
  input: GitHubRepository | ApiSpecification | string;
  options: GenerationOptions;
}

export interface GenerationOptions {
  includeTests: boolean;
  includeDocumentation: boolean;
  targetLanguage: 'typescript' | 'python' | 'go';
  deploymentTarget: 'gist' | 'private-repo' | 'enterprise';
  customInstructions?: string;
}

export interface McpDeploymentConfig {
  type: 'gist' | 'private-repo' | 'vercel' | 'cloud-run';
  settings: Record<string, any>;
  environmentVariables?: Record<string, string>;
}