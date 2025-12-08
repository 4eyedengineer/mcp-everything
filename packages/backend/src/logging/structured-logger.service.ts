import { Injectable, LoggerService, Scope } from '@nestjs/common';
import { v4 as uuid } from 'uuid';

/**
 * Log context that can be attached to any log entry
 */
export interface LogContext {
  correlationId?: string;
  conversationId?: string;
  userId?: string;
  service?: string;
  method?: string;
  duration?: number;
  [key: string]: any;
}

/**
 * Structured log entry format
 */
export interface StructuredLogEntry {
  timestamp: string;
  level: 'debug' | 'verbose' | 'info' | 'warn' | 'error';
  message: string;
  service: string;
  correlationId: string;
  conversationId?: string;
  userId?: string;
  duration?: number;
  trace?: string;
  [key: string]: any;
}

/**
 * StructuredLoggerService
 *
 * Provides structured JSON logging with correlation IDs, context propagation,
 * and consistent formatting across all services. Implements NestJS LoggerService
 * interface for seamless integration.
 *
 * Features:
 * - JSON-formatted output for log aggregators
 * - Correlation ID threading through requests
 * - Conversation and user context tracking
 * - Duration tracking for operations
 * - Log level filtering based on environment
 *
 * @example
 * ```typescript
 * @Injectable()
 * export class MyService {
 *   private readonly logger: StructuredLoggerService;
 *
 *   constructor(loggerService: StructuredLoggerService) {
 *     this.logger = loggerService.setContext('MyService');
 *   }
 *
 *   async doWork(conversationId: string) {
 *     this.logger.log('Starting work', { conversationId });
 *   }
 * }
 * ```
 */
@Injectable({ scope: Scope.TRANSIENT })
export class StructuredLoggerService implements LoggerService {
  private context: string = 'Application';
  private correlationId: string = uuid();
  private persistentContext: LogContext = {};

  /**
   * Current log level threshold
   * Levels: debug=0, verbose=1, info=2, warn=3, error=4
   */
  private static readonly LOG_LEVELS: Record<string, number> = {
    debug: 0,
    verbose: 1,
    info: 2,
    warn: 3,
    error: 4,
  };

  /**
   * Get the minimum log level from environment
   */
  private getMinLogLevel(): number {
    const envLevel = process.env.LOG_LEVEL?.toLowerCase() || 'info';
    const isDevelopment = process.env.NODE_ENV === 'development';

    // In development, default to debug level if not specified
    if (isDevelopment && !process.env.LOG_LEVEL) {
      return StructuredLoggerService.LOG_LEVELS.debug;
    }

    return StructuredLoggerService.LOG_LEVELS[envLevel] ?? StructuredLoggerService.LOG_LEVELS.info;
  }

  /**
   * Check if a log level should be emitted
   */
  private shouldLog(level: string): boolean {
    const levelValue = StructuredLoggerService.LOG_LEVELS[level] ?? 2;
    return levelValue >= this.getMinLogLevel();
  }

  /**
   * Set the service context for all log entries
   * @returns this - for chaining
   */
  setContext(context: string): this {
    this.context = context;
    return this;
  }

  /**
   * Set the correlation ID for request threading
   * @returns this - for chaining
   */
  setCorrelationId(id: string): this {
    this.correlationId = id;
    return this;
  }

  /**
   * Set persistent context that will be included in all log entries
   * @returns this - for chaining
   */
  setPersistentContext(context: LogContext): this {
    this.persistentContext = { ...this.persistentContext, ...context };
    return this;
  }

  /**
   * Clear persistent context
   * @returns this - for chaining
   */
  clearPersistentContext(): this {
    this.persistentContext = {};
    return this;
  }

  /**
   * Log an info message
   */
  log(message: string, context?: LogContext | string): void {
    const ctx = typeof context === 'string' ? { service: context } : context;
    this.emit('info', message, ctx);
  }

  /**
   * Log an error message with optional stack trace
   */
  error(message: string, trace?: string, context?: LogContext | string): void {
    const ctx = typeof context === 'string' ? { service: context } : context;
    this.emit('error', message, { ...ctx, trace });
  }

  /**
   * Log a warning message
   */
  warn(message: string, context?: LogContext | string): void {
    const ctx = typeof context === 'string' ? { service: context } : context;
    this.emit('warn', message, ctx);
  }

  /**
   * Log a debug message (only in development or when LOG_LEVEL=debug)
   */
  debug(message: string, context?: LogContext | string): void {
    const ctx = typeof context === 'string' ? { service: context } : context;
    this.emit('debug', message, ctx);
  }

  /**
   * Log a verbose message
   */
  verbose(message: string, context?: LogContext | string): void {
    const ctx = typeof context === 'string' ? { service: context } : context;
    this.emit('verbose', message, ctx);
  }

  /**
   * Create a child logger with additional context
   * Useful for creating scoped loggers within a request
   */
  child(additionalContext: LogContext): StructuredLoggerService {
    const childLogger = new StructuredLoggerService();
    childLogger.context = this.context;
    childLogger.correlationId = this.correlationId;
    childLogger.persistentContext = { ...this.persistentContext, ...additionalContext };
    return childLogger;
  }

  /**
   * Time an operation and log its duration
   * @returns A function to call when the operation completes
   */
  startTimer(operation: string, context?: LogContext): () => void {
    const startTime = Date.now();
    this.debug(`Starting: ${operation}`, context);

    return () => {
      const duration = Date.now() - startTime;
      this.log(`Completed: ${operation}`, { ...context, duration });
    };
  }

  /**
   * Emit a structured log entry
   */
  private emit(level: string, message: string, context?: LogContext): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const logEntry: StructuredLogEntry = {
      timestamp: new Date().toISOString(),
      level: level as StructuredLogEntry['level'],
      message,
      service: context?.service || this.context,
      correlationId: context?.correlationId || this.correlationId,
      ...this.persistentContext,
      ...context,
    };

    // Remove undefined values for cleaner output
    const cleanEntry = Object.fromEntries(
      Object.entries(logEntry).filter(([, v]) => v !== undefined),
    );

    // Output as JSON for log aggregators
    if (level === 'error') {
      console.error(JSON.stringify(cleanEntry));
    } else if (level === 'warn') {
      console.warn(JSON.stringify(cleanEntry));
    } else if (level === 'debug' || level === 'verbose') {
      console.debug(JSON.stringify(cleanEntry));
    } else {
      console.log(JSON.stringify(cleanEntry));
    }
  }
}
