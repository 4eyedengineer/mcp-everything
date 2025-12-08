import {
  Controller,
  Get,
  Patch,
  Param,
  Body,
  Query,
  ParseIntPipe,
  DefaultValuePipe,
  NotFoundException,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ErrorLoggingService, ErrorStats } from './error-logging.service';
import { ErrorLog } from '../database/entities';

/**
 * DTO for marking an error as resolved
 */
class ResolveErrorDto {
  resolution: string;
}

/**
 * DTO for marking multiple errors as resolved
 */
class ResolveMultipleErrorsDto {
  ids: string[];
  resolution: string;
}

/**
 * ErrorLogController
 *
 * Provides API endpoints for querying and managing error logs.
 * Intended for development/admin use to debug and track application errors.
 */
@Controller('api/v1/errors')
export class ErrorLogController {
  constructor(private readonly errorLoggingService: ErrorLoggingService) {}

  /**
   * Get recent errors
   * GET /api/v1/errors?limit=100
   */
  @Get()
  async getRecentErrors(
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit: number,
  ): Promise<ErrorLog[]> {
    return this.errorLoggingService.getRecentErrors(Math.min(limit, 500));
  }

  /**
   * Get unresolved errors only
   * GET /api/v1/errors/unresolved?limit=100
   */
  @Get('unresolved')
  async getUnresolvedErrors(
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit: number,
  ): Promise<ErrorLog[]> {
    return this.errorLoggingService.getUnresolvedErrors(Math.min(limit, 500));
  }

  /**
   * Get error statistics
   * GET /api/v1/errors/stats
   */
  @Get('stats')
  async getErrorStats(): Promise<ErrorStats> {
    return this.errorLoggingService.getErrorStats();
  }

  /**
   * Get errors for a specific conversation
   * GET /api/v1/errors/conversation/:conversationId
   */
  @Get('conversation/:conversationId')
  async getErrorsByConversation(
    @Param('conversationId') conversationId: string,
  ): Promise<ErrorLog[]> {
    return this.errorLoggingService.getErrorsByConversation(conversationId);
  }

  /**
   * Get errors for a specific user
   * GET /api/v1/errors/user/:userId
   */
  @Get('user/:userId')
  async getErrorsByUser(@Param('userId') userId: string): Promise<ErrorLog[]> {
    return this.errorLoggingService.getErrorsByUser(userId);
  }

  /**
   * Get errors for a specific service
   * GET /api/v1/errors/service/:service?limit=100
   */
  @Get('service/:service')
  async getErrorsByService(
    @Param('service') service: string,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit: number,
  ): Promise<ErrorLog[]> {
    return this.errorLoggingService.getErrorsByService(
      service,
      Math.min(limit, 500),
    );
  }

  /**
   * Get a specific error by ID
   * GET /api/v1/errors/:id
   */
  @Get(':id')
  async getErrorById(@Param('id') id: string): Promise<ErrorLog> {
    const error = await this.errorLoggingService.getErrorById(id);
    if (!error) {
      throw new NotFoundException(`Error log with ID ${id} not found`);
    }
    return error;
  }

  /**
   * Mark an error as resolved
   * PATCH /api/v1/errors/:id/resolve
   */
  @Patch(':id/resolve')
  @HttpCode(HttpStatus.NO_CONTENT)
  async markResolved(
    @Param('id') id: string,
    @Body() body: ResolveErrorDto,
  ): Promise<void> {
    const error = await this.errorLoggingService.getErrorById(id);
    if (!error) {
      throw new NotFoundException(`Error log with ID ${id} not found`);
    }
    await this.errorLoggingService.markResolved(id, body.resolution);
  }

  /**
   * Mark multiple errors as resolved
   * PATCH /api/v1/errors/resolve-multiple
   */
  @Patch('resolve-multiple')
  @HttpCode(HttpStatus.NO_CONTENT)
  async markMultipleResolved(
    @Body() body: ResolveMultipleErrorsDto,
  ): Promise<void> {
    await this.errorLoggingService.markMultipleResolved(
      body.ids,
      body.resolution,
    );
  }
}
