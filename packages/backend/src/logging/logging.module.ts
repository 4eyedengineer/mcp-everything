import { Module, Global, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ErrorLog } from '../database/entities';
import { ErrorLoggingService } from './error-logging.service';
import { ErrorLogController } from './error-log.controller';
import { GlobalExceptionFilter } from './global-exception.filter';
import { StructuredLoggerService } from './structured-logger.service';
import { CorrelationMiddleware } from './correlation.middleware';
import { LogViewerController } from './log-viewer.controller';

/**
 * LoggingModule
 *
 * Provides comprehensive logging infrastructure including:
 * - Structured JSON logging with StructuredLoggerService
 * - Error persistence with ErrorLoggingService
 * - Request correlation tracking with CorrelationMiddleware
 * - Log querying with LogViewerController
 * - Global exception handling with GlobalExceptionFilter
 *
 * This module is marked as @Global so logging services can be
 * injected anywhere without explicitly importing the module.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([ErrorLog])],
  controllers: [ErrorLogController, LogViewerController],
  providers: [
    ErrorLoggingService,
    GlobalExceptionFilter,
    StructuredLoggerService,
    CorrelationMiddleware,
  ],
  exports: [
    ErrorLoggingService,
    GlobalExceptionFilter,
    StructuredLoggerService,
    CorrelationMiddleware,
  ],
})
export class LoggingModule implements NestModule {
  /**
   * Apply correlation middleware to all routes
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('*');
  }
}
