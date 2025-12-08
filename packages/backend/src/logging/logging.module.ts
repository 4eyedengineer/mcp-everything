import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ErrorLog } from '../database/entities';
import { ErrorLoggingService } from './error-logging.service';
import { ErrorLogController } from './error-log.controller';
import { GlobalExceptionFilter } from './global-exception.filter';

/**
 * LoggingModule
 *
 * Provides error logging and tracking infrastructure.
 * This module is marked as @Global so ErrorLoggingService can be
 * injected anywhere without explicitly importing the module.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([ErrorLog])],
  controllers: [ErrorLogController],
  providers: [ErrorLoggingService, GlobalExceptionFilter],
  exports: [ErrorLoggingService, GlobalExceptionFilter],
})
export class LoggingModule {}
