import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  Sse,
  MessageEvent,
  Logger,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Observable, Subject, interval, takeUntil } from 'rxjs';
import { map, finalize } from 'rxjs/operators';

import { ValidationService } from './validation.service';
import {
  ValidationOptions,
  ValidationResponse,
  ValidationStatusResponse,
  ValidationProgressUpdate,
} from './types/validation.types';

/**
 * DTO for validation request
 */
class ValidateDeploymentDto {
  cpuLimit?: string;
  memoryLimit?: string;
  timeout?: number;
  toolTimeout?: number;
  forceRevalidate?: boolean;
}

/**
 * Controller for MCP server validation endpoints
 */
@Controller('api/validation')
export class ValidationController {
  private readonly logger = new Logger(ValidationController.name);

  constructor(private readonly validationService: ValidationService) {}

  /**
   * Trigger validation for a deployment
   */
  @Post(':deploymentId/validate')
  async validateDeployment(
    @Param('deploymentId') deploymentId: string,
    @Body() options: ValidateDeploymentDto = {},
  ): Promise<ValidationResponse> {
    this.logger.log(`Validation requested for deployment: ${deploymentId}`);

    try {
      const validationOptions: ValidationOptions = {
        cpuLimit: options.cpuLimit,
        memoryLimit: options.memoryLimit,
        timeout: options.timeout,
        toolTimeout: options.toolTimeout,
        forceRevalidate: options.forceRevalidate,
      };

      return await this.validationService.validateDeployment(
        deploymentId,
        validationOptions,
      );
    } catch (error) {
      this.logger.error(`Validation failed: ${error.message}`);
      throw new HttpException(
        {
          success: false,
          deploymentId,
          validationStatus: 'failed',
          message: error.message,
        },
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Get validation status for a deployment
   */
  @Get(':deploymentId/status')
  async getValidationStatus(
    @Param('deploymentId') deploymentId: string,
  ): Promise<ValidationStatusResponse> {
    this.logger.log(`Getting validation status for deployment: ${deploymentId}`);

    try {
      return await this.validationService.getValidationStatus(deploymentId);
    } catch (error) {
      this.logger.error(`Failed to get validation status: ${error.message}`);
      throw new HttpException(
        {
          deploymentId,
          validationStatus: 'failed',
          message: error.message,
        },
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Stream validation progress via SSE
   */
  @Sse(':deploymentId/stream')
  streamValidationProgress(
    @Param('deploymentId') deploymentId: string,
  ): Observable<MessageEvent> {
    this.logger.log(`Starting validation stream for deployment: ${deploymentId}`);

    const subject = new Subject<ValidationProgressUpdate>();
    const done$ = new Subject<void>();

    // Register callback to receive progress updates
    this.validationService.registerProgressCallback(deploymentId, (update) => {
      subject.next(update);
      if (update.type === 'complete' || update.type === 'error') {
        // Close stream after completion
        setTimeout(() => {
          done$.next();
          done$.complete();
        }, 1000);
      }
    });

    // Cleanup on stream close
    return subject.pipe(
      takeUntil(done$),
      map((update) => ({
        data: update,
        type: 'validation_progress',
      })),
      finalize(() => {
        this.logger.log(`Closing validation stream for deployment: ${deploymentId}`);
        this.validationService.unregisterProgressCallback(deploymentId);
      }),
    );
  }

  /**
   * Poll GitHub Actions for validation results
   */
  @Post(':deploymentId/poll-github')
  async pollGitHubActions(
    @Param('deploymentId') deploymentId: string,
  ): Promise<ValidationResponse> {
    this.logger.log(`Polling GitHub Actions for deployment: ${deploymentId}`);

    try {
      return await this.validationService.pollGitHubActionsValidation(deploymentId);
    } catch (error) {
      this.logger.error(`GitHub Actions polling failed: ${error.message}`);
      throw new HttpException(
        {
          success: false,
          deploymentId,
          validationStatus: 'failed',
          message: error.message,
        },
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Health check for validation service
   */
  @Get('health')
  async healthCheck(): Promise<{ status: string; timestamp: Date }> {
    return {
      status: 'healthy',
      timestamp: new Date(),
    };
  }
}
