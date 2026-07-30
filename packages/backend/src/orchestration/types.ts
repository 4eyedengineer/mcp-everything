// Import test result types from mcp-testing service
import type { McpServerTestResult, ToolTestResult } from '../testing/mcp-testing.service';
import type { RequiredEnvVar, CollectedEnvVar } from '../types/env-variable.types';

// Re-export for external use
export type { McpServerTestResult, ToolTestResult };
export type { RequiredEnvVar, CollectedEnvVar };

/**
 * The ordered steps of the generation pipeline.
 *
 * `provideHelp` and `handleError` are terminal steps that replace a full run.
 */
export const PIPELINE_STEPS = [
  'analyzeIntent',
  'research',
  'planTools',
  'clarify',
  'refine',
  'persist',
  'provideHelp',
  'handleError',
] as const;

export type PipelineStepName = (typeof PIPELINE_STEPS)[number];

export type PipelineStepStatus = 'running' | 'succeeded' | 'failed';

/**
 * Pipeline State
 *
 * The single mutable object threaded through the generation pipeline. It is
 * persisted (JSON-serialised) into `conversations.state.pipeline` whenever the
 * pipeline pauses for clarification, which is what makes a run resumable on the
 * user's next message.
 */
export interface PipelineState {
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

  // Step: research
  researchPhase?: {
    webSearchFindings?: WebSearchFindings; // Optional: may not have web search results
    githubDeepDive?: DeepGitHubAnalysis; // Optional: not all inputs are GitHub repos
    apiDocumentation?: ApiDocAnalysis; // Optional: may not have API docs
    synthesizedPlan: SynthesizedPlan; // Always required
    researchConfidence: number; // 0-1, always required
    researchIterations: number; // Always required
  };

  // Step: planTools - the plan the refinement loop generates code from
  generationPlan?: {
    steps: string[];
    toolsToGenerate: Array<{
      name: string;
      description: string;
      parameters: any;
      readOnly?: boolean;
    }>;
    estimatedComplexity: 'simple' | 'moderate' | 'complex';
    serverName?: string;
    /** Why these tools and no others - surfaced in logs and PipelineRun rows. */
    rationale?: string;
    /** How the user's stated scope constrained the plan. */
    scopeNotes?: string;
  };

  // Step: refine - generated code
  generatedCode?: {
    mainFile: string;
    packageJson?: string;
    tsConfig?: string;
    supportingFiles: Record<string, string>;
    tests?: string;
    documentation?: string;
    metadata?: {
      tools: Array<{
        name: string;
        description?: string;
        inputSchema?: any;
      }>;
      iteration: number;
      serverName: string;
    };
  };

  /**
   * Reserved for per-step execution output surfaced over SSE
   * (`data.executionResults`). Kept for the streaming contract.
   */
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

  // ===== USER TOOL SCOPE CONSTRAINTS (Issue #137) =====

  // Explicit tool count/names the user asked for, derived semantically by the
  // intent step (never by regex). If set, the pipeline MUST respect them.
  requestedToolCount?: number; // e.g. "with 2 tools" -> 2
  requestedToolNames?: string[]; // e.g. "add and multiply" -> ["add", "multiply"]
  maxToolCount?: number; // hard cap handed to the planner
  /** True when the user asked for read-only/non-mutating tools. */
  readOnlyOnly?: boolean;
  /** Verbatim scope wording from the user, forwarded to the planner prompt. */
  scopeConstraint?: string;

  // Metadata
  currentStep: PipelineStepName;
  executedSteps: PipelineStepName[];
  needsUserInput: boolean;
  isComplete: boolean;
  error?: string;

  // Streaming updates (cumulative on the state; yielded as deltas)
  streamingUpdates?: Array<{
    node: string;
    message: string;
    timestamp: Date;
  }>;

  // Step: clarify
  clarificationHistory?: Array<{
    gaps: KnowledgeGap[];
    questions: ClarificationQuestion[];
    userResponses?: string;
    timestamp: Date;
  }>;

  // Step: refine
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

/**
 * Step: research
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
    parameters?: any;
  }>;
  authentication: {
    type: string;
    details: string;
  };
  rateLimit?: {
    requests: number;
    window: string;
  };
  baseUrl?: string;
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
 * Step: clarify
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
 * Step: refine
 *
 * Note: McpServerTestResult and ToolTestResult are imported at the top of this
 * file from ../testing/mcp-testing.service to avoid duplicate definitions.
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
 * LLM-as-judge quality gate result (see RefinementService.judgeCodeQuality).
 */
export interface CodeQualityJudgement {
  isValid: boolean;
  score: number; // 0-100
  feedback: string;
  issues: Array<{
    category: 'typescript' | 'mcp-protocol' | 'tool-implementation' | 'code-quality';
    message: string;
    suggestion: string;
  }>;
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
