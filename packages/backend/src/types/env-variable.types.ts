/**
 * Type definitions for Environment Variable Management
 *
 * These types support secure handling of API keys and secrets
 * for generated MCP servers.
 */

/**
 * Represents a required environment variable detected during generation
 */
export interface RequiredEnvVar {
  /** Environment variable name (e.g., 'STRIPE_API_KEY') */
  name: string;

  /** Human-readable description of what this key is for */
  description: string;

  /** Whether this env var is required for the server to function */
  required: boolean;

  /** Regex pattern for validation (e.g., 'sk_test_*' or 'sk_live_*') */
  format?: string;

  /** Link to documentation on where to get this key */
  documentationUrl?: string;

  /** Category of the service this key is for */
  category: EnvVarCategory;

  /** Default value (only for non-sensitive values) */
  defaultValue?: string;

  /** Whether this is a sensitive/secret value */
  sensitive: boolean;
}

/**
 * Categories of environment variables
 */
export type EnvVarCategory =
  | 'authentication' // API keys, tokens
  | 'database' // Database connection strings
  | 'storage' // Cloud storage credentials
  | 'messaging' // Email, SMS, push services
  | 'payment' // Payment processing
  | 'analytics' // Analytics and tracking
  | 'ai' // AI/ML services
  | 'cloud' // Cloud provider credentials
  | 'general'; // Other configuration

/**
 * Known patterns for common API key formats
 */
export interface ApiKeyPattern {
  /** Service name (e.g., 'Stripe', 'OpenAI') */
  service: string;

  /** Environment variable name pattern */
  envVarName: string;

  /** Regex pattern to validate the key format */
  validationPattern: RegExp;

  /** Description of the expected format */
  formatDescription: string;

  /** URL to get the API key */
  documentationUrl: string;

  /** Category */
  category: EnvVarCategory;

  /** Example placeholder (masked) */
  examplePlaceholder: string;
}

/**
 * Result of validating an environment variable value
 */
export interface EnvVarValidationResult {
  /** Whether the value is valid */
  isValid: boolean;

  /** Error message if invalid */
  errorMessage?: string;

  /** Suggestions for fixing the value */
  suggestions?: string[];

  /** Whether the value appears to be a test/sandbox key */
  isTestKey?: boolean;
}

/**
 * Environment variable collection request for clarification
 */
export interface EnvVarClarificationRequest {
  /** Environment variables that need to be collected */
  requiredVars: RequiredEnvVar[];

  /** Context about why these variables are needed */
  context: string;

  /** Whether the user can skip optional variables */
  allowSkip: boolean;
}

/**
 * User-provided environment variable values
 */
export interface CollectedEnvVar {
  /** Environment variable name */
  name: string;

  /** Value provided by the user (will be encrypted/masked) */
  value: string;

  /** Whether this was validated successfully */
  validated: boolean;

  /** Whether the user chose to skip this optional variable */
  skipped: boolean;
}

/**
 * Result of environment variable detection during generation
 */
export interface EnvVarDetectionResult {
  /** Detected required environment variables */
  detectedVars: RequiredEnvVar[];

  /** How the variables were detected */
  detectionMethod: 'tool_analysis' | 'code_inference' | 'research_findings';

  /** Confidence in detection accuracy */
  confidence: number;

  /** Reasoning for detected variables */
  reasoning: string;
}

/**
 * GitHub Secret creation request
 */
export interface GitHubSecretRequest {
  /** Repository owner */
  owner: string;

  /** Repository name */
  repo: string;

  /** Secret name */
  secretName: string;

  /** Secret value (will be encrypted) */
  secretValue: string;
}

/**
 * Result of creating GitHub secret
 */
export interface GitHubSecretResult {
  /** Whether the operation succeeded */
  success: boolean;

  /** Secret name that was created/updated */
  secretName: string;

  /** Error message if failed */
  error?: string;
}
