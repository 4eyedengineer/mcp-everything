import { Injectable, Logger } from '@nestjs/common';
import {
  DeploymentErrorCode,
  RetryStrategy,
  ERROR_RETRY_CONFIG,
  RetryAttempt,
  DeploymentError,
  ERROR_USER_MESSAGES,
} from '../types/deployment-errors.types';

/**
 * Result of a retry operation
 */
export interface RetryResult<T> {
  result?: T;
  error?: DeploymentError;
  attempts: RetryAttempt[];
}

/**
 * Context for a retry operation
 */
export interface RetryContext {
  operation: string;
  maxRetries?: number;
}

@Injectable()
export class DeploymentRetryService {
  private readonly logger = new Logger(DeploymentRetryService.name);

  /**
   * Parse a GitHub API error and return a structured deployment error
   */
  parseGitHubError(error: unknown): DeploymentError {
    const err = error as {
      status?: number;
      response?: { status?: number; headers?: Record<string, string> };
      headers?: Record<string, string>;
      message?: string;
    };

    const status = err.status || err.response?.status;
    const message = err.message || 'Unknown error';

    let code: DeploymentErrorCode;

    switch (status) {
      case 401:
        code = DeploymentErrorCode.AUTHENTICATION_FAILED;
        break;
      case 403:
        if (message.includes('rate limit') || message.includes('secondary')) {
          code = message.includes('secondary')
            ? DeploymentErrorCode.SECONDARY_RATE_LIMIT
            : DeploymentErrorCode.RATE_LIMIT_EXCEEDED;
        } else {
          code = DeploymentErrorCode.INSUFFICIENT_PERMISSIONS;
        }
        break;
      case 404:
        code = message.toLowerCase().includes('gist')
          ? DeploymentErrorCode.GIST_NOT_FOUND
          : DeploymentErrorCode.REPOSITORY_NOT_FOUND;
        break;
      case 422:
        if (message.includes('name already exists')) {
          code = DeploymentErrorCode.REPOSITORY_NAME_CONFLICT;
        } else {
          code = DeploymentErrorCode.INVALID_SERVER_NAME;
        }
        break;
      case 429:
        code = DeploymentErrorCode.RATE_LIMIT_EXCEEDED;
        break;
      case 502:
      case 503:
      case 504:
        code = DeploymentErrorCode.SERVICE_UNAVAILABLE;
        break;
      case 0:
      case undefined:
        if (message.includes('timeout') || message.includes('ETIMEDOUT')) {
          code = DeploymentErrorCode.NETWORK_TIMEOUT;
        } else if (message.includes('ECONNRESET')) {
          code = DeploymentErrorCode.CONNECTION_RESET;
        } else {
          code = DeploymentErrorCode.UNKNOWN_ERROR;
        }
        break;
      default:
        code = DeploymentErrorCode.UNKNOWN_ERROR;
    }

    const config = ERROR_RETRY_CONFIG[code];
    const retryAfterMs = this.extractRetryAfter(err);

    return {
      code,
      message,
      userMessage: ERROR_USER_MESSAGES[code],
      retryStrategy: config.strategy,
      retryAfterMs: retryAfterMs || config.baseDelayMs,
    };
  }

  /**
   * Extract retry-after timing from GitHub response headers
   */
  private extractRetryAfter(error: {
    response?: { headers?: Record<string, string> };
    headers?: Record<string, string>;
  }): number | undefined {
    const resetHeader =
      error.response?.headers?.['x-ratelimit-reset'] ||
      error.headers?.['x-ratelimit-reset'];

    if (resetHeader) {
      const resetTime = parseInt(resetHeader, 10) * 1000;
      const waitTime = resetTime - Date.now();
      if (waitTime > 0 && waitTime < 60000) {
        return waitTime + 1000; // Add 1s buffer
      }
    }

    const retryAfter = error.response?.headers?.['retry-after'];
    if (retryAfter) {
      return parseInt(retryAfter, 10) * 1000;
    }

    return undefined;
  }

  /**
   * Execute a function with retry logic based on error type
   */
  async withRetry<T>(
    fn: () => Promise<T>,
    context: RetryContext,
    onRetry?: (attempt: RetryAttempt) => Promise<void>,
  ): Promise<RetryResult<T>> {
    const attempts: RetryAttempt[] = [];
    let lastError: DeploymentError | undefined;

    const maxRetries = context.maxRetries ?? 3;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await fn();
        return { result, attempts };
      } catch (error) {
        lastError = this.parseGitHubError(error);
        const config = ERROR_RETRY_CONFIG[lastError.code];

        const retryAttempt: RetryAttempt = {
          attemptNumber: attempt + 1,
          timestamp: new Date().toISOString(),
          errorCode: lastError.code,
          errorMessage: lastError.message,
        };
        attempts.push(retryAttempt);

        // Log the error
        this.logger.warn(
          `${context.operation} failed (attempt ${attempt + 1}): ${lastError.code} - ${lastError.message}`,
        );

        // Check if we should retry
        if (
          config.strategy === RetryStrategy.NONE ||
          config.strategy === RetryStrategy.MANUAL
        ) {
          break;
        }

        if (attempt >= maxRetries) {
          break;
        }

        // Calculate delay
        const delayMs =
          config.strategy === RetryStrategy.EXPONENTIAL_BACKOFF
            ? Math.pow(2, attempt) * config.baseDelayMs
            : config.baseDelayMs;

        const actualDelay = lastError.retryAfterMs
          ? Math.max(delayMs, lastError.retryAfterMs)
          : delayMs;

        retryAttempt.waitedMs = actualDelay;

        this.logger.log(
          `Waiting ${actualDelay}ms before retry ${attempt + 2}`,
        );

        if (onRetry) {
          await onRetry(retryAttempt);
        }

        await this.delay(actualDelay);
      }
    }

    return { error: lastError, attempts };
  }

  /**
   * Generate alternative server names for naming conflicts
   */
  generateAlternativeNames(baseName: string, count: number = 3): string[] {
    const suggestions: string[] = [];
    const timestamp = Date.now().toString().slice(-6);

    suggestions.push(`${baseName}-${timestamp}`);
    suggestions.push(`${baseName}-v2`);
    suggestions.push(`${baseName}-${Math.random().toString(36).slice(2, 6)}`);

    return suggestions.slice(0, count);
  }

  /**
   * Check if an error code allows retry
   */
  canRetry(errorCode: DeploymentErrorCode, currentRetries: number = 0): boolean {
    const config = ERROR_RETRY_CONFIG[errorCode];
    return (
      config.strategy !== RetryStrategy.NONE &&
      config.strategy !== RetryStrategy.MANUAL &&
      currentRetries < config.maxRetries
    );
  }

  /**
   * Get retry strategy for an error code
   */
  getRetryStrategy(errorCode: DeploymentErrorCode): RetryStrategy {
    return ERROR_RETRY_CONFIG[errorCode].strategy;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
