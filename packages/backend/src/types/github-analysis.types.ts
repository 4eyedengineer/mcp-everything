/**
 * Type definitions for GitHub repository analysis
 *
 * These types define the structure of the comprehensive analysis
 * performed by the GitHubAnalysisService on GitHub repositories.
 */

export interface FileTreeNode {
  path: string;
  type: 'file' | 'dir';
  size?: number;
  downloadUrl?: string;
  extension?: string;
}

export interface TechnologyStack {
  languages: string[];
  frameworks: string[];
  databases: string[];
  tools: string[];
  packageManagers: string[];
  buildSystems: string[];
  confidence: number;
}

export interface ApiPattern {
  type: 'REST' | 'GraphQL' | 'gRPC' | 'WebSocket';
  endpoints: string[];
  methods: string[];
  patterns: string[];
  confidence: number;
}

export interface SourceFile {
  path: string;
  content: string;
  size: number;
  type: 'main' | 'config' | 'package' | 'readme' | 'other';
  language?: string;
}

export interface RepositoryFeatures {
  hasApi: boolean;
  hasCli: boolean;
  hasDatabase: boolean;
  hasTests: boolean;
  hasDocumentation: boolean;
  hasDocker: boolean;
  hasCi: boolean;
  features: string[];
}

export interface RepositoryMetadata {
  name: string;
  fullName: string;
  description: string | null;
  language: string | null;
  size: number;
  stargazersCount: number;
  forksCount: number;
  topics: string[];
  license: string | null;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  homepage: string | null;
}

export interface ReadmeAnalysis {
  content: string | null;
  extractedFeatures: string[];
  installation: string[];
  usage: string[];
}

export interface QualityMetrics {
  hasReadme: boolean;
  hasTests: boolean;
  hasLicense: boolean;
  hasContributing: boolean;
  hasChangelog: boolean;
  hasDocumentation: boolean;
  score: number;
}

export interface RepositoryAnalysis {
  metadata: RepositoryMetadata;
  fileTree: FileTreeNode[];
  techStack: TechnologyStack;
  apiPatterns: ApiPattern[];
  sourceFiles: SourceFile[];
  features: RepositoryFeatures;
  readme: ReadmeAnalysis;
  quality: QualityMetrics;
}

// Analysis request/response types for API
export interface AnalysisRequest {
  githubUrl: string;
  options?: {
    includeFileContent?: boolean;
    maxSourceFiles?: number;
    includeTests?: boolean;
  };
}

export interface AnalysisResponse {
  success: boolean;
  analysis?: RepositoryAnalysis;
  error?: string;
  metadata?: {
    analysisTime: number;
    apiCallsUsed: number;
    cacheHit: boolean;
  };
}

// Utility types for filtering and searching
export type FileType = 'source' | 'config' | 'documentation' | 'test' | 'build' | 'other';
export type AnalysisScope = 'basic' | 'detailed' | 'comprehensive';
export type TechCategory = 'frontend' | 'backend' | 'mobile' | 'desktop' | 'cli' | 'library' | 'other';

export interface AnalysisFilter {
  includeFiles?: string[];
  excludeFiles?: string[];
  maxDepth?: number;
  scope?: AnalysisScope;
  categories?: TechCategory[];
}