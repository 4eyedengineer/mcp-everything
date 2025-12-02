/**
 * Deployment Error Types
 *
 * Structured error codes, retry strategies, and user-friendly messages
 * for comprehensive deployment error handling.
 */

/**
 * Deployment Error Codes
 * Categorized by their retry strategy
 */
export enum DeploymentErrorCode {
  // === IMMEDIATE RETRY (Network/Transient) ===
  NETWORK_TIMEOUT = 'NETWORK_TIMEOUT',
  CONNECTION_RESET = 'CONNECTION_RESET',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',

  // === EXPONENTIAL BACKOFF (Rate Limits) ===
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
  SECONDARY_RATE_LIMIT = 'SECONDARY_RATE_LIMIT',

  // === MANUAL RETRY (User Intervention Required) ===
  INVALID_CODE = 'INVALID_CODE',
  COMPILATION_ERROR = 'COMPILATION_ERROR',
  MISSING_DEPENDENCIES = 'MISSING_DEPENDENCIES',
  INVALID_SERVER_NAME = 'INVALID_SERVER_NAME',

  // === NO RETRY (Fatal) ===
  AUTHENTICATION_FAILED = 'AUTHENTICATION_FAILED',
  INSUFFICIENT_PERMISSIONS = 'INSUFFICIENT_PERMISSIONS',
  REPOSITORY_NAME_CONFLICT = 'REPOSITORY_NAME_CONFLICT',
  GIST_NOT_FOUND = 'GIST_NOT_FOUND',
  REPOSITORY_NOT_FOUND = 'REPOSITORY_NOT_FOUND',

  // === INTERNAL ===
  UNKNOWN_ERROR = 'UNKNOWN_ERROR',
  NO_FILES_TO_DEPLOY = 'NO_FILES_TO_DEPLOY',
  CONVERSATION_NOT_FOUND = 'CONVERSATION_NOT_FOUND',
}

/**
 * Retry strategies for different error types
 */
export enum RetryStrategy {
  /** Retry up to 3 times immediately with short delay */
  IMMEDIATE = 'immediate',
  /** Wait and retry with increasing delays (2s, 4s, 8s) */
  EXPONENTIAL_BACKOFF = 'exponential_backoff',
  /** Requires user action before retrying */
  MANUAL = 'manual',
  /** Do not retry - fatal error */
  NONE = 'none',
}

/**
 * Structured deployment error with all context
 */
export interface DeploymentError {
  code: DeploymentErrorCode;
  message: string;
  userMessage: string;
  retryStrategy: RetryStrategy;
  retryAfterMs?: number;
  suggestedAction?: string;
  details?: Record<string, unknown>;
}

/**
 * Record of a single retry attempt
 */
export interface RetryAttempt {
  attemptNumber: number;
  timestamp: string;
  errorCode: DeploymentErrorCode;
  errorMessage: string;
  waitedMs?: number;
}

/**
 * Extended deployment metadata for error tracking
 */
export interface DeploymentMetadataExtended {
  options?: Record<string, unknown>;
  gistId?: string;
  rawUrl?: string;
  retryAttempts?: RetryAttempt[];
  totalRetries?: number;
  lastRetryAt?: string;
  rollbackPerformed?: boolean;
  rollbackReason?: string;
  suggestedNames?: string[];
  errorCode?: DeploymentErrorCode;
  retryStrategy?: RetryStrategy;
}

/**
 * Configuration for retry behavior per error code
 */
export interface RetryConfig {
  strategy: RetryStrategy;
  maxRetries: number;
  baseDelayMs: number;
}

/**
 * Error code to retry strategy mapping
 */
export const ERROR_RETRY_CONFIG: Record<DeploymentErrorCode, RetryConfig> = {
  // Immediate retry - network issues
  [DeploymentErrorCode.NETWORK_TIMEOUT]: {
    strategy: RetryStrategy.IMMEDIATE,
    maxRetries: 3,
    baseDelayMs: 1000,
  },
  [DeploymentErrorCode.CONNECTION_RESET]: {
    strategy: RetryStrategy.IMMEDIATE,
    maxRetries: 3,
    baseDelayMs: 1000,
  },
  [DeploymentErrorCode.SERVICE_UNAVAILABLE]: {
    strategy: RetryStrategy.IMMEDIATE,
    maxRetries: 3,
    baseDelayMs: 2000,
  },

  // Exponential backoff - rate limits
  [DeploymentErrorCode.RATE_LIMIT_EXCEEDED]: {
    strategy: RetryStrategy.EXPONENTIAL_BACKOFF,
    maxRetries: 3,
    baseDelayMs: 2000,
  },
  [DeploymentErrorCode.SECONDARY_RATE_LIMIT]: {
    strategy: RetryStrategy.EXPONENTIAL_BACKOFF,
    maxRetries: 3,
    baseDelayMs: 5000,
  },

  // Manual retry - code issues
  [DeploymentErrorCode.INVALID_CODE]: {
    strategy: RetryStrategy.MANUAL,
    maxRetries: 0,
    baseDelayMs: 0,
  },
  [DeploymentErrorCode.COMPILATION_ERROR]: {
    strategy: RetryStrategy.MANUAL,
    maxRetries: 0,
    baseDelayMs: 0,
  },
  [DeploymentErrorCode.MISSING_DEPENDENCIES]: {
    strategy: RetryStrategy.MANUAL,
    maxRetries: 0,
    baseDelayMs: 0,
  },
  [DeploymentErrorCode.INVALID_SERVER_NAME]: {
    strategy: RetryStrategy.MANUAL,
    maxRetries: 0,
    baseDelayMs: 0,
  },

  // No retry - fatal errors
  [DeploymentErrorCode.AUTHENTICATION_FAILED]: {
    strategy: RetryStrategy.NONE,
    maxRetries: 0,
    baseDelayMs: 0,
  },
  [DeploymentErrorCode.INSUFFICIENT_PERMISSIONS]: {
    strategy: RetryStrategy.NONE,
    maxRetries: 0,
    baseDelayMs: 0,
  },
  [DeploymentErrorCode.REPOSITORY_NAME_CONFLICT]: {
    strategy: RetryStrategy.NONE,
    maxRetries: 0,
    baseDelayMs: 0,
  },
  [DeploymentErrorCode.GIST_NOT_FOUND]: {
    strategy: RetryStrategy.NONE,
    maxRetries: 0,
    baseDelayMs: 0,
  },
  [DeploymentErrorCode.REPOSITORY_NOT_FOUND]: {
    strategy: RetryStrategy.NONE,
    maxRetries: 0,
    baseDelayMs: 0,
  },

  // Internal errors
  [DeploymentErrorCode.UNKNOWN_ERROR]: {
    strategy: RetryStrategy.IMMEDIATE,
    maxRetries: 1,
    baseDelayMs: 1000,
  },
  [DeploymentErrorCode.NO_FILES_TO_DEPLOY]: {
    strategy: RetryStrategy.MANUAL,
    maxRetries: 0,
    baseDelayMs: 0,
  },
  [DeploymentErrorCode.CONVERSATION_NOT_FOUND]: {
    strategy: RetryStrategy.NONE,
    maxRetries: 0,
    baseDelayMs: 0,
  },
};

/**
 * User-friendly error messages for each error code
 */
export const ERROR_USER_MESSAGES: Record<DeploymentErrorCode, string> = {
  [DeploymentErrorCode.NETWORK_TIMEOUT]:
    'Network timeout. Retrying automatically...',
  [DeploymentErrorCode.CONNECTION_RESET]:
    'Connection was reset. Retrying...',
  [DeploymentErrorCode.SERVICE_UNAVAILABLE]:
    'GitHub service temporarily unavailable. Retrying...',
  [DeploymentErrorCode.RATE_LIMIT_EXCEEDED]:
    'GitHub rate limit reached. Waiting before retry...',
  [DeploymentErrorCode.SECONDARY_RATE_LIMIT]:
    'GitHub secondary rate limit hit. Please wait a moment.',
  [DeploymentErrorCode.INVALID_CODE]:
    'Generated code has errors. Please regenerate the server.',
  [DeploymentErrorCode.COMPILATION_ERROR]:
    'Code compilation failed. Please check the generated code.',
  [DeploymentErrorCode.MISSING_DEPENDENCIES]:
    'Missing dependencies detected. Please regenerate.',
  [DeploymentErrorCode.INVALID_SERVER_NAME]:
    'Invalid server name. Please use alphanumeric characters and hyphens.',
  [DeploymentErrorCode.AUTHENTICATION_FAILED]:
    'GitHub authentication failed. Please check your credentials.',
  [DeploymentErrorCode.INSUFFICIENT_PERMISSIONS]:
    'Insufficient GitHub permissions for this operation.',
  [DeploymentErrorCode.REPOSITORY_NAME_CONFLICT]:
    'Repository name already exists. Try a different name.',
  [DeploymentErrorCode.GIST_NOT_FOUND]:
    'Gist not found. It may have been deleted.',
  [DeploymentErrorCode.REPOSITORY_NOT_FOUND]:
    'Repository not found. It may have been deleted.',
  [DeploymentErrorCode.UNKNOWN_ERROR]:
    'An unexpected error occurred. Please try again.',
  [DeploymentErrorCode.NO_FILES_TO_DEPLOY]:
    'No files to deploy. Please generate the server first.',
  [DeploymentErrorCode.CONVERSATION_NOT_FOUND]:
    'Conversation not found.',
};
