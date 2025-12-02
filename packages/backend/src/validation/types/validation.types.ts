/**
 * Validation status for deployed MCP servers
 */
export type ValidationStatus =
  | 'pending'
  | 'running'
  | 'passed'
  | 'failed'
  | 'skipped';

/**
 * Source of validation (how the validation was performed)
 */
export type ValidationSource = 'local_docker' | 'github_actions' | 'manual';

/**
 * Individual tool test result
 */
export interface ToolValidationResult {
  toolName: string;
  success: boolean;
  error?: string;
  executionTime: number;
  mcpCompliant?: boolean;
  output?: any;
}

/**
 * Complete validation result for an MCP server
 */
export interface ValidationResult {
  buildSuccess: boolean;
  buildDuration?: number;
  buildError?: string;
  toolResults: ToolValidationResult[];
  errors?: string[];
  source: ValidationSource;
  containerId?: string;
  imageTag?: string;
}

/**
 * Request to validate a deployment
 */
export interface ValidateDeploymentRequest {
  deploymentId: string;
  options?: ValidationOptions;
}

/**
 * Options for validation execution
 */
export interface ValidationOptions {
  cpuLimit?: string;
  memoryLimit?: string;
  timeout?: number;
  toolTimeout?: number;
  forceRevalidate?: boolean;
}

/**
 * Response from validation endpoint
 */
export interface ValidationResponse {
  success: boolean;
  deploymentId: string;
  validationStatus: ValidationStatus;
  message: string;
  result?: ValidationResult;
  validatedAt?: Date;
  toolsPassedCount?: number;
  toolsTestedCount?: number;
}

/**
 * Validation status response
 */
export interface ValidationStatusResponse {
  deploymentId: string;
  validationStatus: ValidationStatus;
  validatedAt?: Date;
  toolsPassedCount?: number;
  toolsTestedCount?: number;
  validationResults?: ValidationResult;
  workflowRunId?: string;
}

/**
 * Progress update for streaming validation
 */
export interface ValidationProgressUpdate {
  type:
    | 'starting'
    | 'building'
    | 'testing'
    | 'testing_tool'
    | 'complete'
    | 'error'
    | 'cleanup';
  message: string;
  phase?: string;
  progress?: number;
  toolName?: string;
  toolIndex?: number;
  totalTools?: number;
  timestamp: Date;
}

/**
 * GitHub Actions workflow run info
 */
export interface WorkflowRunInfo {
  id: number;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion?: 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required';
  htmlUrl: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Generated code structure for validation
 */
export interface GeneratedCodeForValidation {
  mainFile: string;
  packageJson: string;
  tsConfig?: string;
  supportingFiles: Record<string, string>;
  metadata: {
    tools: Array<{ name: string; inputSchema: any; description: string }>;
    serverName: string;
  };
}
