/**
 * TypeScript interfaces for Ensemble Agent system
 * Ensures type safety for prompt input/output
 */

// ============================================================================
// Input Data Types
// ============================================================================

export interface ResearchPhaseData {
  researchPhase: {
    webSearchFindings: {
      patterns: string[];
      bestPractices: string[];
    };
    githubDeepDive: {
      basicInfo: {
        name: string;
        description: string;
        language: string;
        stars: number;
      };
      codeExamples: Array<{
        file: string;
        content: string;
        language: string;
      }>;
      testPatterns: Array<{
        framework: string;
        pattern: string;
      }>;
      apiUsagePatterns: Array<{
        endpoint: string;
        method: string;
      }>;
      dependencies: Record<string, string>;
    };
    synthesizedPlan: {
      summary: string;
      keyInsights: string[];
      recommendedApproach: string;
      confidence: number;
    };
  };
  extractedData: {
    githubUrl: string;
    repositoryName: string;
    targetFramework?: string;
  };
}

// ============================================================================
// Output Data Types
// ============================================================================

export type ToolPriority = 'high' | 'medium' | 'low';
export type ToolComplexity = 'simple' | 'moderate' | 'complex';

export interface JsonSchemaProperty {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';
  description: string;
  enum?: string[] | number[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  default?: any;
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface JsonSchema {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required: string[];
  additionalProperties?: boolean;
}

export interface ToolRecommendation {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  outputFormat: string;
  priority: ToolPriority;
  estimatedComplexity: ToolComplexity;
}

export interface AgentRecommendations {
  tools: ToolRecommendation[];
  reasoning: string;
  concerns: string[];
}

export interface AgentResponse {
  agentName: 'architectAgent' | 'securityAgent' | 'performanceAgent' | 'mcpSpecialistAgent';
  recommendations: AgentRecommendations;
  confidence: number; // 0.0 - 1.0
}

// ============================================================================
// Voting System Types
// ============================================================================

export interface AgentConfig {
  name: string;
  systemPrompt: string;
  weight: number;
}

export interface AgentWeights {
  architectAgent: number;    // 1.0
  securityAgent: number;      // 0.8
  performanceAgent: number;   // 0.8
  mcpSpecialistAgent: number; // 1.2
}

export interface WeightedToolRecommendation extends ToolRecommendation {
  votes: number; // Weighted sum
  sources: string[]; // Which agents recommended this tool
  averageConfidence: number;
  consensusSchema: JsonSchema; // Merged schema (MCP specialist wins conflicts)
  securityEnhancements?: {
    validationConstraints: string[];
    authRequirements: string[];
    riskLevel: 'low' | 'medium' | 'high';
  };
  performanceCharacteristics?: {
    expectedResponseTime: string;
    cachingStrategy?: string;
    rateLimitConsiderations?: string;
  };
}

export interface EnsembleVotingResult {
  topTools: WeightedToolRecommendation[];
  allRecommendations: AgentResponse[];
  consensusLevel: number; // 0.0-1.0, how much agents agreed
  overallConfidence: number; // Weighted average confidence
  votingMetadata: {
    totalAgents: number;
    successfulResponses: number;
    averageResponseTime: number;
    totalCost: number; // USD
  };
}

// ============================================================================
// Validation Types
// ============================================================================

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface ToolValidation extends ValidationResult {
  toolName: string;
  schemaValid: boolean;
  namingCompliant: boolean; // lowercase_underscore
  hasDescriptions: boolean; // All params documented
  requiredFieldsMinimal: boolean; // <= 3 required fields
  outputFormatSpecified: boolean;
}

export interface EnsembleValidation extends ValidationResult {
  jsonParseRate: number; // % of agents that returned valid JSON
  schemaValidityRate: number; // % of tools with valid JSON Schema
  protocolComplianceRate: number; // % MCP-compliant tools
  recommendationDiversity: number; // % unique tools per agent
  toolValidations: ToolValidation[];
}

// ============================================================================
// Metrics & Analytics Types
// ============================================================================

export interface AgentMetrics {
  agentName: string;
  averageConfidence: number;
  toolsRecommended: number;
  uniqueTools: number; // Not recommended by other agents
  jsonParseSuccessRate: number;
  averageResponseTime: number; // milliseconds
  costPerRecommendation: number; // USD
}

export interface EnsembleMetrics {
  totalGenerations: number;
  averageToolsPerGeneration: number;
  averageConsensusLevel: number;
  jsonParseRate: number;
  schemaValidityRate: number;
  protocolComplianceRate: number;
  recommendationDiversity: number;
  votingConsensus: number; // % top-10 tools recommended by 2+ agents
  generationSuccessRate: number; // % tools that compile and work
  agentMetrics: AgentMetrics[];
  costMetrics: {
    totalCost: number;
    averageCostPerGeneration: number;
    costByAgent: Record<string, number>;
  };
  performanceMetrics: {
    averageLatency: number;
    p95Latency: number;
    parallelExecutionSpeedup: number; // vs sequential
  };
}

// ============================================================================
// Error Handling Types
// ============================================================================

export type AgentErrorType =
  | 'INVALID_JSON'
  | 'MISSING_REQUIRED_FIELD'
  | 'INVALID_SCHEMA'
  | 'TIMEOUT'
  | 'API_ERROR'
  | 'VALIDATION_FAILURE';

export interface AgentError {
  agentName: string;
  errorType: AgentErrorType;
  message: string;
  rawResponse?: string;
  timestamp: Date;
}

export interface EnsembleError {
  errors: AgentError[];
  partialResults?: AgentResponse[];
  fallbackStrategy: 'USE_PARTIAL' | 'RETRY' | 'FAIL';
}

// ============================================================================
// Prompt Configuration Types
// ============================================================================

export interface PromptConfig {
  maxTokens: number; // 2000 recommended
  temperature: number; // 0.3 recommended for consistency
  stopSequences?: string[];
  systemPrompt: string;
}

export interface EnsembleConfig {
  agents: Record<string, AgentConfig>;
  weights: AgentWeights;
  execution: {
    parallel: boolean; // true = 4x faster
    timeout: number; // milliseconds
    retryAttempts: number;
  };
  voting: {
    minConsensus: number; // 0.5 = at least 2 agents must agree
    topToolsCount: number; // 10 recommended
    schemaConflictResolution: 'MCP_SPECIALIST_WINS' | 'MOST_RESTRICTIVE' | 'VOTE';
  };
  validation: {
    strictSchemaValidation: boolean;
    enforceNamingConvention: boolean;
    maxRequiredFields: number; // 3 recommended
  };
}

// ============================================================================
// Utility Types
// ============================================================================

export type AgentName = 'architectAgent' | 'securityAgent' | 'performanceAgent' | 'mcpSpecialistAgent';

export interface AgentPromptInput {
  agentName: AgentName;
  researchData: ResearchPhaseData;
  config: PromptConfig;
}

export interface AgentPromptOutput {
  agentName: AgentName;
  response: AgentResponse;
  metadata: {
    tokenCount: {
      input: number;
      output: number;
    };
    responseTime: number; // milliseconds
    cost: number; // USD
  };
}

// ============================================================================
// Export All Types
// ============================================================================

export type {
  // Input
  ResearchPhaseData,

  // Output
  ToolRecommendation,
  AgentRecommendations,
  AgentResponse,
  WeightedToolRecommendation,
  EnsembleVotingResult,

  // Validation
  ValidationResult,
  ToolValidation,
  EnsembleValidation,

  // Metrics
  AgentMetrics,
  EnsembleMetrics,

  // Errors
  AgentError,
  EnsembleError,

  // Configuration
  PromptConfig,
  AgentConfig,
  EnsembleConfig,

  // Utilities
  AgentPromptInput,
  AgentPromptOutput,
};
