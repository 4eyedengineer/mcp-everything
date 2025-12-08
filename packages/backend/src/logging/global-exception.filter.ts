import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ErrorLoggingService } from './error-logging.service';

/**
 * GlobalExceptionFilter
 *
 * Catches all unhandled exceptions and logs them to the database.
 * Provides a consistent error response format across the application.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  constructor(private readonly errorLoggingService: ErrorLoggingService) {}

  async catch(exception: unknown, host: ArgumentsHost): Promise<void> {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    // Convert to Error if needed
    const error =
      exception instanceof Error ? exception : new Error(String(exception));

    // Determine HTTP status
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    // Extract conversation ID from various sources
    const conversationId = this.extractConversationId(request);

    // Extract user ID if available (for future auth integration)
    const userId = this.extractUserId(request);

    // Determine if this is a fatal error (5xx)
    const level = status >= 500 ? 'error' : 'warn';

    // Log to database (don't await to avoid blocking response)
    this.errorLoggingService
      .logError({
        error,
        level,
        service: 'HTTP',
        method: `${request.method} ${request.url}`,
        conversationId,
        userId,
        context: {
          statusCode: status,
          path: request.url,
          method: request.method,
          query: request.query,
          params: request.params,
          body: this.sanitizeBody(request.body),
          headers: this.sanitizeHeaders(request.headers),
          ip: request.ip,
          userAgent: request.get('user-agent'),
        },
      })
      .catch((logError) => {
        // If logging fails, just log to console
        this.logger.error(`Failed to log error to database: ${logError.message}`);
      });

    // Build error response
    const errorResponse = this.buildErrorResponse(error, status, request);

    // Send response
    response.status(status).json(errorResponse);
  }

  /**
   * Build a consistent error response
   */
  private buildErrorResponse(
    error: Error,
    status: number,
    request: Request,
  ): Record<string, any> {
    const isDevelopment = process.env.NODE_ENV === 'development';

    const response: Record<string, any> = {
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      message: this.getErrorMessage(error, status),
    };

    // Include error code if available
    const errorCode = (error as any).code || (error as any).errorCode;
    if (errorCode) {
      response.errorCode = errorCode;
    }

    // Include stack trace in development only
    if (isDevelopment && error.stack) {
      response.stack = error.stack;
    }

    // Include validation errors if present (class-validator)
    if (
      status === HttpStatus.BAD_REQUEST &&
      (error as any).response?.message
    ) {
      response.details = (error as any).response.message;
    }

    return response;
  }

  /**
   * Get user-friendly error message
   */
  private getErrorMessage(error: Error, status: number): string {
    // For HTTP exceptions, use the exception message
    if (error instanceof HttpException) {
      const response = error.getResponse();
      if (typeof response === 'string') {
        return response;
      }
      if (typeof response === 'object' && 'message' in response) {
        const msg = (response as any).message;
        return Array.isArray(msg) ? msg.join(', ') : String(msg);
      }
    }

    // For 5xx errors in production, return generic message
    if (status >= 500 && process.env.NODE_ENV === 'production') {
      return 'An internal server error occurred';
    }

    return error.message || 'An unexpected error occurred';
  }

  /**
   * Extract conversation ID from request
   */
  private extractConversationId(request: Request): string | undefined {
    // Check URL params
    if (request.params?.conversationId) {
      return request.params.conversationId;
    }
    if (request.params?.id && request.url.includes('conversation')) {
      return request.params.id;
    }

    // Check body
    if (request.body?.conversationId) {
      return request.body.conversationId;
    }

    // Check query params
    if (request.query?.conversationId) {
      return request.query.conversationId as string;
    }

    // Check URL path for conversation ID pattern
    const urlMatch = request.url.match(
      /\/conversation[s]?\/([0-9a-f-]{36})/i,
    );
    if (urlMatch) {
      return urlMatch[1];
    }

    return undefined;
  }

  /**
   * Extract user ID from request (for future auth integration)
   */
  private extractUserId(request: Request): string | undefined {
    // Check if user is attached to request (by auth middleware)
    const user = (request as any).user;
    if (user?.id) {
      return user.id;
    }

    // Check headers for user ID (development/testing)
    const headerUserId = request.headers['x-user-id'];
    if (headerUserId && typeof headerUserId === 'string') {
      return headerUserId;
    }

    return undefined;
  }

  /**
   * Sanitize request headers to remove sensitive information
   */
  private sanitizeHeaders(
    headers: Record<string, any>,
  ): Record<string, string> {
    const sensitiveHeaders = [
      'authorization',
      'cookie',
      'x-api-key',
      'x-auth-token',
      'x-access-token',
    ];

    const sanitized: Record<string, string> = {};

    for (const [key, value] of Object.entries(headers)) {
      const lowerKey = key.toLowerCase();
      if (sensitiveHeaders.includes(lowerKey)) {
        sanitized[key] = '[REDACTED]';
      } else if (typeof value === 'string') {
        sanitized[key] = value;
      } else if (Array.isArray(value)) {
        sanitized[key] = value.join(', ');
      }
    }

    return sanitized;
  }

  /**
   * Sanitize request body to remove sensitive information
   */
  private sanitizeBody(body: any): any {
    if (!body || typeof body !== 'object') {
      return body;
    }

    const sensitiveFields = [
      'password',
      'token',
      'apiKey',
      'secret',
      'credential',
      'accessToken',
      'refreshToken',
    ];

    const sanitize = (obj: any): any => {
      if (Array.isArray(obj)) {
        return obj.map(sanitize);
      }

      if (typeof obj !== 'object' || obj === null) {
        return obj;
      }

      const result: Record<string, any> = {};
      for (const [key, value] of Object.entries(obj)) {
        const lowerKey = key.toLowerCase();
        if (sensitiveFields.some((f) => lowerKey.includes(f))) {
          result[key] = '[REDACTED]';
        } else if (typeof value === 'object') {
          result[key] = sanitize(value);
        } else {
          result[key] = value;
        }
      }
      return result;
    };

    return sanitize(body);
  }
}
