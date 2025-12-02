// Import test result types from mcp-testing service
import type { McpServerTestResult, ToolTestResult } from '../testing/mcp-testing.service';
import type { RequiredEnvVar, CollectedEnvVar } from '../types/env-variable.types';

// Re-export for external use
export type { McpServerTestResult, ToolTestResult };
export type { RequiredEnvVar, CollectedEnvVar };

/**
 * LangGraph State Definition
 * Represents the complete state of a conversation/generation workflow
 */
export interface GraphState {
  // Conversation context
  sessionId: string;
  conversationId?: string;
  messages: Array<{
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: Date;
  }>;

  // Current user input
  userInput: string;

  // Intent and analysis
  intent?: {
    type: 'generate_mcp' | 'clarify' | 'research' | 'help' | 'unknown';
    confidence: number;
    reasoning?: string;
  };

  // Extracted information
  extractedData?: {
    githubUrl?: string;
    repositoryName?: string;
    apiSpecUrl?: string;
    customRequirements?: string[];
    targetFramework?: string;
  };

  // Research and context gathering
  researchResults?: {
    githubAnalysis?: any;
    documentationContent?: string;
    codePatterns?: any[];
    apiEndpoints?: any[];
  };

  // Generation workflow
  generationPlan?: {
    steps: string[];
    toolsToGenerate: Array<{
      name: string;
      description: string;
      parameters: any;
    }>;
    estimatedComplexity: 'simple' | 'moderate' | 'complex';
  };

  // Code generation
  generatedCode?: {
    mainFile: string;
    supportingFiles: Record<string, string>;
    tests?: string;
    documentation?: string;
  };

  // Execution and validation
  executionResults?: Array<{
    step: string;
    success: boolean;
    output?: any;
    error?: string;
    timestamp: Date;
  }>;

  // Clarification needed
  clarificationNeeded?: {
    question: string;
    options?: string[];
    context: string;
  };

  // Final response
  response?: string;

  // Metadata
  currentNode: string;
  executedNodes: string[];
  needsUserInput: boolean;
  isComplete: boolean;
  error?: string;

  // Streaming updates
  streamingUpdates?: Array<{
    node: string;
    message: string;
    timestamp: Date;
  }>;

  // ===== ENSEMBLE ARCHITECTURE FIELDS =====

  // Phase 1: Research & Planning (Input-Agnostic)
  researchPhase?: {
    webSearchFindings?: WebSearchFindings; // Optional: May not have web search results
    githubDeepDive?: DeepGitHubAnalysis; // Optional: Not all inputs are GitHub repos
    apiDocumentation?: ApiDocAnalysis; // Optional: May not have API docs
    synthesizedPlan: SynthesizedPlan; // Always required
    researchConfidence: number; // 0-1, always required
    researchIterations: number; // Always required
  };

  // Phase 2: Ensemble Reasoning
  ensembleResults?: {
    agentPerspectives: AgentPerspective[];
    consensusScore: number; // 0-1
    conflictsResolved: boolean;
    votingDetails: VotingDetails;
  };

  // Phase 3: Clarification
  clarificationHistory?: Array<{
    gaps: KnowledgeGap[];
    questions: ClarificationQuestion[];
    userResponses?: string;
    timestamp: Date;
  }>;
  clarificationComplete?: boolean;

  // Phase 4: Refinement Loop
  refinementIteration?: number;
  refinementHistory?: Array<{
    iteration: number;
    testResults: McpServerTestResult;
    failureAnalysis: FailureAnalysis;
    timestamp: Date;
  }>;

  // ===== ENVIRONMENT VARIABLE MANAGEMENT =====

  // Detected environment variables from tool analysis
  detectedEnvVars?: RequiredEnvVar[];

  // Collected environment variable values from user
  collectedEnvVars?: CollectedEnvVar[];

  // Whether env var collection is complete
  envVarCollectionComplete?: boolean;
}

/**
 * Node execution result
 */
export interface NodeResult {
  state: Partial<GraphState>;
  nextNode?: string | string[];
  shouldStream?: {
    message: string;
    type: 'progress' | 'result' | 'error' | 'clarification';
  };
}

/**
 * Tool execution context for LLM-generated code
 */
export interface CodeExecutionContext {
  code: string;
  timeout: number;
  memoryLimit: number;
  allowedModules?: string[];
}

/**
 * Tool execution result
 */
export interface CodeExecutionResult {
  success: boolean;
  output?: any;
  error?: string;
  executionTime: number;
  memoryUsed?: number;
}

// ===== ENSEMBLE ARCHITECTURE TYPES =====

/**
 * Phase 1: Research Types
 */
export interface WebSearchFindings {
  queries: string[];
  results: Array<{
    url: string;
    title: string;
    snippet: string;
    relevanceScore?: number;
  }>;
  patterns: string[];
  bestPractices: string[];
  timestamp: Date;
}

export interface DeepGitHubAnalysis {
  basicInfo: {
    name: string;
    description: string;
    language: string;
    stars: number;
    topics: string[];
  };
  codeExamples: Array<{
    file: string;
    content: string;
    language: string;
  }>;
  testPatterns: Array<{
    framework: string;
    pattern: string;
    examples: string[];
  }>;
  apiUsagePatterns: Array<{
    endpoint: string;
    method: string;
    parameters: any;
    exampleUsage: string;
  }>;
  dependencies: Record<string, string>;
}

export interface ApiDocAnalysis {
  endpoints: Array<{
    path: string;
    method: string;
    description: string;
    parameters: any;
  }>;
  authentication: {
    type: string;
    details: string;
  };
  rateLimit?: {
    requests: number;
    window: string;
  };
}

export interface SynthesizedPlan {
  summary: string;
  keyInsights: string[];
  recommendedApproach: string;
  potentialChallenges: string[];
  confidence: number; // 0-1
  reasoning: string;
}

/**
 * Phase 2: Ensemble Types
 */
export interface AgentPerspective {
  agentName: 'architect' | 'security' | 'performance' | 'mcpSpecialist';
  recommendations: {
    tools: ToolRecommendation[];
    reasoning: string;
    concerns: string[];
  };
  confidence: number; // 0-1
  weight: number;
  timestamp: Date;
}

export interface ToolRecommendation {
  name: string;
  description: string;
  inputSchema: any;
  outputFormat: string;
  priority: 'high' | 'medium' | 'low';
  estimatedComplexity: 'simple' | 'moderate' | 'complex';
}

export interface VotingDetails {
  totalVotes: number;
  toolVotes: Map<string, Vote[]>;
  consensusReached: boolean;
  conflictingRecommendations?: Array<{
    tool: string;
    conflict: string;
    resolution: string;
  }>;
}

export interface Vote {
  agent: string;
  toolName: string;
  confidence: number;
  weight: number;
  recommendation: ToolRecommendation;
}

/**
 * Phase 3: Clarification Types
 */
export interface KnowledgeGap {
  issue: string;
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  suggestedQuestion: string;
  context: string;
}

export interface ClarificationQuestion {
  question: string;
  context: string;
  options?: string[];
  required: boolean;
}

/**
 * Phase 4: Refinement Types
 *
 * Note: McpServerTestResult and ToolTestResult are imported at the top of this file
 * from ../testing/mcp-testing.service to avoid duplicate definitions
 */

export interface FailureAnalysis {
  failureCount: number;
  categories: Array<{
    type: 'syntax' | 'runtime' | 'mcp_protocol' | 'logic' | 'timeout';
    count: number;
  }>;
  rootCauses: string[];
  fixes: Array<{
    toolName: string;
    issue: string;
    solution: string;
    priority: 'HIGH' | 'MEDIUM' | 'LOW';
    codeSnippet?: string;
  }>;
  recommendation: string;
}

/**
 * Research Cache Types
 */
export interface CachedResearch {
  githubUrl: string;
  researchPhase: GraphState['researchPhase'];
  cachedAt: Date;
  expiresAt: Date;
  embedding?: number[]; // Vector embedding for semantic search
  accessCount: number;
}

/**
 * Docker Configuration Types
 */
export interface DockerConfig {
  image: string;
  cpuLimit: string; // e.g., "0.5" for 50%
  memoryLimit: string; // e.g., "512m"
  timeout: number; // seconds
  network: 'none' | 'bridge' | 'host';
  volumes?: Record<string, string>;
}
