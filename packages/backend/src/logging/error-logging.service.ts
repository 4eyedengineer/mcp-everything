import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan } from 'typeorm';
import { ErrorLog } from '../database/entities';

/**
 * Parameters for logging an error
 */
export interface LogErrorParams {
  error: Error;
  level?: 'error' | 'warn' | 'fatal';
  service?: string;
  method?: string;
  conversationId?: string;
  userId?: string;
  context?: Record<string, any>;
}

/**
 * Error statistics response
 */
export interface ErrorStats {
  total: number;
  unresolved: number;
  byService: Record<string, number>;
  byErrorCode: Record<string, number>;
  byLevel: Record<string, number>;
  last24Hours: number;
  last7Days: number;
}

/**
 * ErrorLoggingService
 *
 * Provides error persistence and querying capabilities for development debugging.
 * All application errors are stored in the database for later analysis.
 */
@Injectable()
export class ErrorLoggingService {
  private readonly logger = new Logger(ErrorLoggingService.name);

  constructor(
    @InjectRepository(ErrorLog)
    private readonly errorLogRepository: Repository<ErrorLog>,
  ) {}

  /**
   * Log an error to the database
   */
  async logError(params: LogErrorParams): Promise<ErrorLog> {
    try {
      const errorLog = this.errorLogRepository.create({
        timestamp: new Date(),
        level: params.level || 'error',
        message: this.truncateMessage(params.error.message),
        stack: params.error.stack,
        service: params.service,
        method: params.method,
        conversationId: params.conversationId,
        userId: params.userId,
        context: this.sanitizeContext(params.context),
        errorCode: this.extractErrorCode(params.error),
        resolved: false,
      });

      const saved = await this.errorLogRepository.save(errorLog);

      // Also log to console for immediate visibility
      this.logger.error(
        `[${params.service || 'Unknown'}::${params.method || 'unknown'}] ${params.error.message}`,
        params.error.stack,
      );

      return saved;
    } catch (dbError) {
      // If database logging fails, at least log to console
      this.logger.error(
        `Failed to persist error to database: ${dbError.message}`,
      );
      this.logger.error(
        `Original error: [${params.service}::${params.method}] ${params.error.message}`,
        params.error.stack,
      );
      throw dbError;
    }
  }

  /**
   * Log a warning to the database
   */
  async logWarning(params: Omit<LogErrorParams, 'level'>): Promise<ErrorLog> {
    return this.logError({ ...params, level: 'warn' });
  }

  /**
   * Log a fatal error to the database
   */
  async logFatal(params: Omit<LogErrorParams, 'level'>): Promise<ErrorLog> {
    return this.logError({ ...params, level: 'fatal' });
  }

  /**
   * Get recent errors with optional limit
   */
  async getRecentErrors(limit = 100): Promise<ErrorLog[]> {
    return this.errorLogRepository.find({
      order: { timestamp: 'DESC' },
      take: limit,
    });
  }

  /**
   * Get unresolved errors
   */
  async getUnresolvedErrors(limit = 100): Promise<ErrorLog[]> {
    return this.errorLogRepository.find({
      where: { resolved: false },
      order: { timestamp: 'DESC' },
      take: limit,
    });
  }

  /**
   * Get errors by conversation ID
   */
  async getErrorsByConversation(conversationId: string): Promise<ErrorLog[]> {
    return this.errorLogRepository.find({
      where: { conversationId },
      order: { timestamp: 'DESC' },
    });
  }

  /**
   * Get errors by user ID
   */
  async getErrorsByUser(userId: string): Promise<ErrorLog[]> {
    return this.errorLogRepository.find({
      where: { userId },
      order: { timestamp: 'DESC' },
    });
  }

  /**
   * Get errors by service name
   */
  async getErrorsByService(service: string, limit = 100): Promise<ErrorLog[]> {
    return this.errorLogRepository.find({
      where: { service },
      order: { timestamp: 'DESC' },
      take: limit,
    });
  }

  /**
   * Get aggregated error statistics
   */
  async getErrorStats(): Promise<ErrorStats> {
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    // Get total count
    const total = await this.errorLogRepository.count();

    // Get unresolved count
    const unresolved = await this.errorLogRepository.count({
      where: { resolved: false },
    });

    // Get count by service
    const byServiceResults = await this.errorLogRepository
      .createQueryBuilder('error')
      .select('error.service', 'service')
      .addSelect('COUNT(*)', 'count')
      .where('error.service IS NOT NULL')
      .groupBy('error.service')
      .getRawMany();

    const byService: Record<string, number> = {};
    for (const row of byServiceResults) {
      byService[row.service] = parseInt(row.count, 10);
    }

    // Get count by error code
    const byErrorCodeResults = await this.errorLogRepository
      .createQueryBuilder('error')
      .select('error.errorCode', 'errorCode')
      .addSelect('COUNT(*)', 'count')
      .where('error.errorCode IS NOT NULL')
      .groupBy('error.errorCode')
      .getRawMany();

    const byErrorCode: Record<string, number> = {};
    for (const row of byErrorCodeResults) {
      byErrorCode[row.errorCode] = parseInt(row.count, 10);
    }

    // Get count by level
    const byLevelResults = await this.errorLogRepository
      .createQueryBuilder('error')
      .select('error.level', 'level')
      .addSelect('COUNT(*)', 'count')
      .groupBy('error.level')
      .getRawMany();

    const byLevel: Record<string, number> = {};
    for (const row of byLevelResults) {
      byLevel[row.level] = parseInt(row.count, 10);
    }

    // Get last 24 hours count
    const last24Hours = await this.errorLogRepository.count({
      where: { timestamp: MoreThan(oneDayAgo) },
    });

    // Get last 7 days count
    const last7Days = await this.errorLogRepository.count({
      where: { timestamp: MoreThan(sevenDaysAgo) },
    });

    return {
      total,
      unresolved,
      byService,
      byErrorCode,
      byLevel,
      last24Hours,
      last7Days,
    };
  }

  /**
   * Mark an error as resolved
   */
  async markResolved(id: string, resolution: string): Promise<void> {
    await this.errorLogRepository.update(id, {
      resolved: true,
      resolution,
    });
  }

  /**
   * Mark multiple errors as resolved
   */
  async markMultipleResolved(ids: string[], resolution: string): Promise<void> {
    await this.errorLogRepository.update(ids, {
      resolved: true,
      resolution,
    });
  }

  /**
   * Get a single error by ID
   */
  async getErrorById(id: string): Promise<ErrorLog | null> {
    return this.errorLogRepository.findOne({ where: { id } });
  }

  /**
   * Delete old resolved errors (cleanup utility)
   */
  async deleteOldResolvedErrors(daysOld = 30): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);

    const result = await this.errorLogRepository
      .createQueryBuilder()
      .delete()
      .where('resolved = :resolved', { resolved: true })
      .andWhere('timestamp < :cutoffDate', { cutoffDate })
      .execute();

    return result.affected || 0;
  }

  /**
   * Extract error code from error (supports custom error types)
   */
  private extractErrorCode(error: Error): string | undefined {
    // Check for common error code properties
    const anyError = error as any;

    if (anyError.code) {
      return String(anyError.code);
    }

    if (anyError.errorCode) {
      return String(anyError.errorCode);
    }

    if (anyError.status) {
      return `HTTP_${anyError.status}`;
    }

    if (anyError.statusCode) {
      return `HTTP_${anyError.statusCode}`;
    }

    // Try to extract from error name
    if (error.name && error.name !== 'Error') {
      return error.name;
    }

    return undefined;
  }

  /**
   * Truncate message to fit database column
   */
  private truncateMessage(message: string): string {
    const maxLength = 500;
    if (message.length <= maxLength) {
      return message;
    }
    return message.substring(0, maxLength - 3) + '...';
  }

  /**
   * Sanitize context to remove sensitive data
   */
  private sanitizeContext(
    context?: Record<string, any>,
  ): Record<string, any> | undefined {
    if (!context) {
      return undefined;
    }

    const sensitiveKeys = [
      'password',
      'token',
      'apiKey',
      'secret',
      'authorization',
      'cookie',
      'session',
      'credential',
      'private',
    ];

    const sanitized = { ...context };

    const sanitizeObject = (obj: any, path = ''): any => {
      if (typeof obj !== 'object' || obj === null) {
        return obj;
      }

      if (Array.isArray(obj)) {
        return obj.map((item, index) => sanitizeObject(item, `${path}[${index}]`));
      }

      const result: Record<string, any> = {};
      for (const [key, value] of Object.entries(obj)) {
        const lowerKey = key.toLowerCase();
        const isSensitive = sensitiveKeys.some((sk) => lowerKey.includes(sk));

        if (isSensitive) {
          result[key] = '[REDACTED]';
        } else if (typeof value === 'object' && value !== null) {
          result[key] = sanitizeObject(value, `${path}.${key}`);
        } else {
          result[key] = value;
        }
      }
      return result;
    };

    return sanitizeObject(sanitized);
  }
}
