/**
 * Type definitions for AI-powered tool discovery
 *
 * These types define the structure for discovering and generating
 * MCP tools from GitHub repository analysis using AI reasoning.
 */

import { RepositoryAnalysis } from './github-analysis.types';

// Core tool definition
export interface McpTool {
  name: string; // snake_case format
  description: string; // Clear, actionable description
  category: ToolCategory;
  inputSchema: JsonSchema;
  implementationHints: ImplementationHints;
  quality: ToolQuality;
}

// Tool categories for organization
export type ToolCategory =
  | 'data'           // Data extraction/manipulation
  | 'api'            // API interaction tools
  | 'file'           // File system operations
  | 'utility'        // General utility functions
  | 'analysis'       // Code/repository analysis
  | 'build'          // Build/deployment tools
  | 'test'           // Testing utilities
  | 'documentation'  // Documentation generation
  | 'search'         // Search/query operations
  | 'transform';     // Data transformation

// JSON Schema definition for tool inputs
export interface JsonSchema {
  type: string;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface JsonSchemaProperty {
  type: string;
  description: string;
  enum?: string[];
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  default?: any;
}

// Implementation guidance for code generation
export interface ImplementationHints {
  primaryAction: string;           // Main operation to perform
  requiredData: string[];          // Data sources needed
  dependencies: string[];          // External dependencies
  complexity: 'simple' | 'medium' | 'complex';
  outputFormat: 'text' | 'json' | 'markdown' | 'html';
  errorHandling: string[];         // Expected error scenarios
  examples: ToolExample[];         // Usage examples
}

export interface ToolExample {
  input: Record<string, any>;
  description: string;
  expectedOutput: string;
}

// Tool quality assessment
export interface ToolQuality {
  usefulness: number;      // 0-1 scale
  specificity: number;     // How repository-specific (0-1)
  implementability: number; // How feasible to implement (0-1)
  uniqueness: number;      // How unique/valuable (0-1)
  overallScore: number;    // Combined score (0-1)
  reasoning: string;       // AI's quality assessment reasoning
}

// Discovery process results
export interface ToolDiscoveryResult {
  success: boolean;
  tools: McpTool[];
  metadata: DiscoveryMetadata;
  error?: string;
}

export interface DiscoveryMetadata {
  repositoryContext: RepositoryContext;
  discoveryMethod: DiscoveryMethod;
  aiReasoning: string;
  processingTime: number;
  iterationCount: number;
  qualityThreshold: number;
}

export interface RepositoryContext {
  primaryLanguage: string;
  frameworks: string[];
  repositoryType: 'library' | 'application' | 'tool' | 'service' | 'other';
  complexity: 'simple' | 'medium' | 'complex';
  domain: string; // web, mobile, cli, data, ml, etc.
}

export type DiscoveryMethod =
  | 'code_analysis'     // Analyzed source code
  | 'readme_extraction' // Found in documentation
  | 'api_mapping'       // Mapped from API patterns
  | 'ai_inference';     // AI-generated from context

// AI prompt templates and configurations
export interface ToolDiscoveryPrompt {
  systemPrompt: string;
  analysisPrompt: string;
  judgePrompt: string;
  regenerationPrompt: string;
}

export interface DiscoveryConfig {
  maxIterations: number;
  qualityThreshold: number;
  maxToolsPerCategory: number;
  preferredCategories: ToolCategory[];
  complexityBias: 'simple' | 'balanced' | 'complex';
}

// AI model responses
export interface AiToolSuggestion {
  tools: Partial<McpTool>[];
  reasoning: string;
  confidence: number;
}

export interface AiQualityJudgment {
  toolName: string;
  isValid: boolean;
  quality: ToolQuality;
  feedback: string;
  suggestedImprovements: string[];
}

export interface AiRegenerationRequest {
  originalTool: Partial<McpTool>;
  feedback: string;
  context: RepositoryContext;
  iteration: number;
}

// Service interfaces
export interface ToolDiscoveryService {
  discoverTools(analysis: RepositoryAnalysis, config?: DiscoveryConfig): Promise<ToolDiscoveryResult>;
  generateToolFromCode(code: string, context: RepositoryContext): Promise<McpTool[]>;
  extractToolsFromReadme(readme: string, context: RepositoryContext): Promise<McpTool[]>;
  mapApiToTools(apiPatterns: any[], context: RepositoryContext): Promise<McpTool[]>;
  judgeToolQuality(tool: Partial<McpTool>, context: RepositoryContext): Promise<AiQualityJudgment>;
}

// Error types
export class ToolDiscoveryError extends Error {
  constructor(
    message: string,
    public code: 'AI_FAILURE' | 'INVALID_INPUT' | 'QUALITY_THRESHOLD' | 'MAX_ITERATIONS',
    public context?: any
  ) {
    super(message);
    this.name = 'ToolDiscoveryError';
  }
}

// Repository-specific tool templates for common patterns
export interface ToolTemplate {
  pattern: RegExp | string;
  category: ToolCategory;
  nameTemplate: string;
  descriptionTemplate: string;
  inputSchemaTemplate: JsonSchema;
  implementationTemplate: ImplementationHints;
}

// Predefined templates for common repository types
export const COMMON_TOOL_TEMPLATES: Record<string, ToolTemplate[]> = {
  'react': [
    {
      pattern: /\.tsx?$/,
      category: 'analysis',
      nameTemplate: 'analyze_component',
      descriptionTemplate: 'Analyze React component structure and props',
      inputSchemaTemplate: {
        type: 'object',
        properties: {
          componentPath: { type: 'string', description: 'Path to React component file' }
        },
        required: ['componentPath']
      },
      implementationTemplate: {
        primaryAction: 'Parse and analyze React component',
        requiredData: ['component source code'],
        dependencies: ['@babel/parser', '@babel/traverse'],
        complexity: 'medium',
        outputFormat: 'json',
        errorHandling: ['file not found', 'parse errors'],
        examples: []
      }
    }
  ],
  'api': [
    {
      pattern: /\/api\/|router|controller/i,
      category: 'api',
      nameTemplate: 'call_endpoint',
      descriptionTemplate: 'Make API calls to repository endpoints',
      inputSchemaTemplate: {
        type: 'object',
        properties: {
          endpoint: { type: 'string', description: 'API endpoint path' },
          method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'], description: 'HTTP method' },
          payload: { type: 'object', description: 'Request payload' }
        },
        required: ['endpoint', 'method']
      },
      implementationTemplate: {
        primaryAction: 'Execute HTTP request',
        requiredData: ['endpoint configuration'],
        dependencies: ['node-fetch', 'axios'],
        complexity: 'simple',
        outputFormat: 'json',
        errorHandling: ['network errors', 'invalid responses'],
        examples: []
      }
    }
  ]
};