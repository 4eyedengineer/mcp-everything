import {
  Controller,
  Get,
  Query,
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, Like, In } from 'typeorm';
import { ErrorLog } from '../database/entities';

/**
 * Log search query parameters
 */
export interface LogSearchQuery {
  level?: string;
  service?: string;
  conversationId?: string;
  userId?: string;
  correlationId?: string;
  from?: string;
  to?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

/**
 * Log search result with pagination info
 */
export interface LogSearchResult {
  logs: ErrorLog[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

/**
 * Log aggregation by field
 */
export interface LogAggregation {
  field: string;
  buckets: Array<{ key: string; count: number }>;
}

/**
 * LogViewerController
 *
 * Provides API endpoints for searching and querying structured logs.
 * Supports filtering by level, service, conversation, user, time range,
 * and full-text search. Also provides aggregation endpoints for analytics.
 *
 * Note: In development, logs are persisted to the ErrorLog table for queryability.
 * In production, logs would typically be sent to a log aggregator (ELK, CloudWatch, etc.)
 * and this controller would interface with that system instead.
 */
@Controller('api/v1/logs')
export class LogViewerController {
  constructor(
    @InjectRepository(ErrorLog)
    private readonly logRepository: Repository<ErrorLog>,
  ) {}

  /**
   * Search logs with multiple filter criteria
   * GET /api/v1/logs
   *
   * @param level - Filter by log level (debug, info, warn, error)
   * @param service - Filter by service name
   * @param conversationId - Filter by conversation ID
   * @param userId - Filter by user ID
   * @param correlationId - Filter by correlation ID
   * @param from - Start date (ISO 8601 format)
   * @param to - End date (ISO 8601 format)
   * @param search - Full-text search in message
   * @param limit - Maximum results to return (default: 100, max: 500)
   * @param offset - Offset for pagination (default: 0)
   */
  @Get()
  async searchLogs(
    @Query('level') level?: string,
    @Query('service') service?: string,
    @Query('conversationId') conversationId?: string,
    @Query('userId') userId?: string,
    @Query('correlationId') correlationId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('search') search?: string,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit = 100,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset = 0,
  ): Promise<LogSearchResult> {
    // Cap limit at 500
    const cappedLimit = Math.min(limit, 500);

    // Build query
    const queryBuilder = this.logRepository.createQueryBuilder('log');

    // Apply filters
    if (level) {
      // Support multiple levels separated by comma
      const levels = level.split(',').map((l) => l.trim().toLowerCase());
      queryBuilder.andWhere('log.level IN (:...levels)', { levels });
    }

    if (service) {
      queryBuilder.andWhere('log.service = :service', { service });
    }

    if (conversationId) {
      queryBuilder.andWhere('log.conversationId = :conversationId', {
        conversationId,
      });
    }

    if (userId) {
      queryBuilder.andWhere('log.userId = :userId', { userId });
    }

    if (correlationId) {
      // Correlation ID is stored in context JSONB
      queryBuilder.andWhere("log.context->>'correlationId' = :correlationId", {
        correlationId,
      });
    }

    if (from) {
      const fromDate = new Date(from);
      if (!isNaN(fromDate.getTime())) {
        queryBuilder.andWhere('log.timestamp >= :from', { from: fromDate });
      }
    }

    if (to) {
      const toDate = new Date(to);
      if (!isNaN(toDate.getTime())) {
        queryBuilder.andWhere('log.timestamp <= :to', { to: toDate });
      }
    }

    if (search) {
      queryBuilder.andWhere('log.message ILIKE :search', {
        search: `%${search}%`,
      });
    }

    // Get total count
    const total = await queryBuilder.getCount();

    // Apply pagination and ordering
    queryBuilder
      .orderBy('log.timestamp', 'DESC')
      .skip(offset)
      .take(cappedLimit);

    // Execute query
    const logs = await queryBuilder.getMany();

    return {
      logs,
      total,
      limit: cappedLimit,
      offset,
      hasMore: offset + logs.length < total,
    };
  }

  /**
   * Get log aggregations by a specific field
   * GET /api/v1/logs/aggregate/:field
   *
   * @param field - Field to aggregate by (level, service, errorCode)
   * @param from - Start date (optional)
   * @param to - End date (optional)
   */
  @Get('aggregate')
  async aggregateLogs(
    @Query('field') field: string = 'level',
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<LogAggregation> {
    // Validate field name to prevent SQL injection
    const allowedFields = ['level', 'service', 'errorCode'];
    const safeField = allowedFields.includes(field) ? field : 'level';

    const queryBuilder = this.logRepository
      .createQueryBuilder('log')
      .select(`log.${safeField}`, 'key')
      .addSelect('COUNT(*)', 'count')
      .where(`log.${safeField} IS NOT NULL`);

    if (from) {
      const fromDate = new Date(from);
      if (!isNaN(fromDate.getTime())) {
        queryBuilder.andWhere('log.timestamp >= :from', { from: fromDate });
      }
    }

    if (to) {
      const toDate = new Date(to);
      if (!isNaN(toDate.getTime())) {
        queryBuilder.andWhere('log.timestamp <= :to', { to: toDate });
      }
    }

    queryBuilder.groupBy(`log.${safeField}`).orderBy('count', 'DESC');

    const results = await queryBuilder.getRawMany();

    return {
      field: safeField,
      buckets: results.map((r) => ({
        key: r.key,
        count: parseInt(r.count, 10),
      })),
    };
  }

  /**
   * Get log timeline (counts over time)
   * GET /api/v1/logs/timeline
   *
   * @param interval - Time interval (hour, day, week)
   * @param from - Start date
   * @param to - End date
   * @param level - Optional level filter
   */
  @Get('timeline')
  async getLogTimeline(
    @Query('interval') interval: string = 'hour',
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('level') level?: string,
  ): Promise<{ interval: string; buckets: Array<{ time: string; count: number }> }> {
    // Determine date truncation based on interval
    const truncFn = {
      hour: "date_trunc('hour', log.timestamp)",
      day: "date_trunc('day', log.timestamp)",
      week: "date_trunc('week', log.timestamp)",
    }[interval] || "date_trunc('hour', log.timestamp)";

    const queryBuilder = this.logRepository
      .createQueryBuilder('log')
      .select(truncFn, 'time')
      .addSelect('COUNT(*)', 'count');

    if (from) {
      const fromDate = new Date(from);
      if (!isNaN(fromDate.getTime())) {
        queryBuilder.andWhere('log.timestamp >= :from', { from: fromDate });
      }
    }

    if (to) {
      const toDate = new Date(to);
      if (!isNaN(toDate.getTime())) {
        queryBuilder.andWhere('log.timestamp <= :to', { to: toDate });
      }
    }

    if (level) {
      const levels = level.split(',').map((l) => l.trim().toLowerCase());
      queryBuilder.andWhere('log.level IN (:...levels)', { levels });
    }

    queryBuilder.groupBy('time').orderBy('time', 'ASC');

    const results = await queryBuilder.getRawMany();

    return {
      interval,
      buckets: results.map((r) => ({
        time: r.time instanceof Date ? r.time.toISOString() : r.time,
        count: parseInt(r.count, 10),
      })),
    };
  }

  /**
   * Get distinct values for a field (for autocomplete/filtering)
   * GET /api/v1/logs/distinct/:field
   */
  @Get('distinct')
  async getDistinctValues(
    @Query('field') field: string = 'service',
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit = 50,
  ): Promise<{ field: string; values: string[] }> {
    // Validate field name
    const allowedFields = ['level', 'service', 'errorCode', 'method'];
    const safeField = allowedFields.includes(field) ? field : 'service';

    const results = await this.logRepository
      .createQueryBuilder('log')
      .select(`DISTINCT log.${safeField}`, 'value')
      .where(`log.${safeField} IS NOT NULL`)
      .orderBy('value', 'ASC')
      .limit(limit)
      .getRawMany();

    return {
      field: safeField,
      values: results.map((r) => r.value),
    };
  }
}
