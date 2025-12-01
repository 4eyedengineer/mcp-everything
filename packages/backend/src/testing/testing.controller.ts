import {
  Controller,
  Post,
  Body,
  Param,
  HttpCode,
  BadRequestException,
  InternalServerErrorException,
  Sse,
  Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { McpTestingService, GeneratedCode, McpServerTestResult } from './mcp-testing.service';

/**
 * Request DTO for test endpoint
 */
export interface TestMcpServerRequest {
  generatedCode: GeneratedCode;
  cpuLimit?: string;
  memoryLimit?: string;
  timeout?: number;
  toolTimeout?: number;
  cleanup?: boolean;
}

/**
 * Response DTO for test endpoint
 */
export interface TestMcpServerResponse {
  success: boolean;
  message: string;
  testId: string;
  result?: McpServerTestResult;
  error?: string;
}

/**
 * Testing Controller
 * Provides REST API endpoints for MCP server testing
 * Supports Server-Sent Events for real-time test progress
 */
@Controller('api/testing')
export class TestingController {
  private readonly logger = new Logger(TestingController.name);
  private activeTests: Map<string, McpServerTestResult> = new Map();

  constructor(private readonly mcpTestingService: McpTestingService) {}

  /**
   * Test MCP server via HTTP (returns full result when complete)
   * Useful for simple testing without real-time updates
   */
  @Post('server')
  @HttpCode(200)
  async testMcpServer(@Body() request: TestMcpServerRequest): Promise<TestMcpServerResponse> {
    try {
      // Validate request
      if (!request.generatedCode) {
        throw new BadRequestException('generatedCode is required');
      }

      if (!request.generatedCode.mainFile) {
        throw new BadRequestException('generatedCode.mainFile is required');
      }

      if (!request.generatedCode.packageJson) {
        throw new BadRequestException('generatedCode.packageJson is required');
      }

      if (!request.generatedCode.metadata || !request.generatedCode.metadata.tools) {
        throw new BadRequestException('generatedCode.metadata.tools is required');
      }

      this.logger.log(
        `Testing MCP server with ${request.generatedCode.metadata.tools.length} tools`,
      );

      // Run test
      const result = await this.mcpTestingService.testMcpServer(request.generatedCode, {
        cpuLimit: request.cpuLimit,
        memoryLimit: request.memoryLimit,
        timeout: request.timeout,
        toolTimeout: request.toolTimeout,
        cleanup: request.cleanup !== false,
      });

      this.logger.log(`Test completed: ${result.toolsPassedCount}/${result.toolsTested} tools passed`);

      return {
        success: result.overallSuccess,
        message: `Test completed: ${result.toolsPassedCount}/${result.toolsTested} tools passed`,
        testId: result.containerId,
        result,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Test failed: ${errorMsg}`);

      if (error instanceof BadRequestException) {
        throw error;
      }

      throw new InternalServerErrorException(`Testing failed: ${errorMsg}`);
    }
  }

  /**
   * Test MCP server with real-time progress streaming via Server-Sent Events
   * Recommended for interactive/frontend use
   *
   * Usage:
   * const eventSource = new EventSource('/api/testing/stream/test-session-id');
   * eventSource.onmessage = (e) => console.log(JSON.parse(e.data));
   */
  @Sse('stream/:sessionId')
  streamTestProgress(
    @Param('sessionId') sessionId: string,
    @Body() request: TestMcpServerRequest,
  ): Observable<MessageEvent> {
    return new Observable((observer) => {
      // Validate request
      if (!request.generatedCode) {
        observer.error(new BadRequestException('generatedCode is required'));
        return;
      }

      this.logger.log(`[${sessionId}] Starting MCP server test with streaming`);

      // Register progress callback
      this.mcpTestingService.registerProgressCallback(sessionId, (update) => {
        observer.next({
          data: JSON.stringify(update),
        } as MessageEvent);
      });

      // Run test asynchronously
      (async () => {
        try {
          const result = await this.mcpTestingService.testMcpServer(
            request.generatedCode,
            {
              cpuLimit: request.cpuLimit,
              memoryLimit: request.memoryLimit,
              timeout: request.timeout,
              toolTimeout: request.toolTimeout,
              cleanup: request.cleanup !== false,
            },
          );

          // Store result for potential retrieval
          this.activeTests.set(sessionId, result);

          // Send final result
          observer.next({
            data: JSON.stringify({
              type: 'final_result',
              result,
              timestamp: new Date(),
            }),
          } as MessageEvent);

          this.logger.log(
            `[${sessionId}] Test streaming complete: ${result.toolsPassedCount}/${result.toolsTested} tools passed`,
          );

          observer.complete();
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          this.logger.error(`[${sessionId}] Test streaming failed: ${errorMsg}`);

          observer.error({
            type: 'error',
            message: errorMsg,
            timestamp: new Date(),
          });
        } finally {
          // Unregister callback
          this.mcpTestingService.unregisterProgressCallback(sessionId);
        }
      })();
    });
  }

  /**
   * Get test results by session ID (for polling if SSE unavailable)
   */
  @Post('results/:sessionId')
  async getTestResults(@Param('sessionId') sessionId: string): Promise<TestMcpServerResponse> {
    const result = this.activeTests.get(sessionId);

    if (!result) {
      return {
        success: false,
        message: 'Test results not found. Session may have expired.',
        testId: sessionId,
      };
    }

    // Remove from active tests after retrieval (or use TTL in real implementation)
    this.activeTests.delete(sessionId);

    return {
      success: result.overallSuccess,
      message: `Test result: ${result.toolsPassedCount}/${result.toolsTested} tools passed`,
      testId: sessionId,
      result,
    };
  }

  /**
   * Health check endpoint
   */
  @Post('health')
  @HttpCode(200)
  async healthCheck(): Promise<{ status: string; docker: boolean }> {
    try {
      // Try to run simple docker command
      const { stdout } = await require('util').promisify(require('child_process').exec)(
        'docker ps -q',
      );

      return {
        status: 'healthy',
        docker: true,
      };
    } catch (error) {
      return {
        status: 'degraded',
        docker: false,
      };
    }
  }
}
