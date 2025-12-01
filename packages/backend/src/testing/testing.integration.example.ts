/**
 * Integration Example: Using McpTestingService in the Ensemble Architecture
 *
 * This example shows how to integrate the testing service into the refinement loop
 * of the ensemble architecture, automatically testing generated MCP servers and
 * providing feedback for regeneration if tests fail.
 */

import { Injectable, Logger } from '@nestjs/common';
import { McpTestingService, GeneratedCode, McpServerTestResult } from './mcp-testing.service';
import { McpGenerationService } from '../mcp-generation.service';

/**
 * Refinement result from testing
 */
interface RefinementResult {
  iteration: number;
  testResult: McpServerTestResult;
  shouldRegenerate: boolean;
  feedback: string;
  toolFailures: Array<{
    toolName: string;
    error: string;
    priority: 'HIGH' | 'MEDIUM' | 'LOW';
  }>;
}

/**
 * Integration service for test-driven refinement
 */
@Injectable()
export class TestDrivenRefinementService {
  private readonly logger = new Logger(TestDrivenRefinementService.name);
  private readonly maxRefinementAttempts = 3;

  constructor(
    private readonly mcpTestingService: McpTestingService,
    private readonly mcpGenerationService: McpGenerationService,
  ) {}

  /**
   * Test generated MCP server and refine if needed
   * Integrates with ensemble architecture's refinement loop
   */
  async refineGeneratedServer(
    initialCode: GeneratedCode,
    onProgress?: (update: any) => void,
  ): Promise<RefinementResult> {
    let currentCode = initialCode;
    let iteration = 0;

    while (iteration < this.maxRefinementAttempts) {
      iteration++;
      this.logger.log(`Refinement iteration ${iteration}/${this.maxRefinementAttempts}`);

      // Test current code
      if (onProgress) {
        onProgress({
          type: 'refinement_testing',
          iteration,
          message: `Testing generated code (iteration ${iteration})...`,
        });
      }

      const testResult = await this.mcpTestingService.testMcpServer(currentCode, {
        timeout: 120,
        toolTimeout: 5,
        cleanup: true,
      });

      // Check if tests passed
      if (testResult.overallSuccess) {
        this.logger.log(`Iteration ${iteration}: All tests passed!`);

        return {
          iteration,
          testResult,
          shouldRegenerate: false,
          feedback: `All ${testResult.toolsTested} tools passed successfully.`,
          toolFailures: [],
        };
      }

      // Analyze failures
      const failures = this.analyzeTestFailures(testResult);

      if (iteration === this.maxRefinementAttempts) {
        this.logger.warn(
          `Max refinement attempts (${this.maxRefinementAttempts}) reached. Stopping.`,
        );

        return {
          iteration,
          testResult,
          shouldRegenerate: false,
          feedback: `Test failed after ${this.maxRefinementAttempts} refinement attempts.`,
          toolFailures: failures,
        };
      }

      // Generate feedback for regeneration
      const regenerationFeedback = this.buildRegenerationFeedback(testResult, failures);

      if (onProgress) {
        onProgress({
          type: 'refinement_regenerating',
          iteration,
          message: `Tests failed. Regenerating with feedback... (${failures.length} issues)`,
          failures,
        });
      }

      this.logger.log(
        `Iteration ${iteration}: ${failures.length} tool failures. Attempting regeneration.`,
      );

      // Regenerate problematic tools
      try {
        currentCode = await this.regenerateFailedTools(currentCode, failures, regenerationFeedback);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        this.logger.error(`Regeneration failed: ${errorMsg}`);

        return {
          iteration,
          testResult,
          shouldRegenerate: false,
          feedback: `Regeneration failed: ${errorMsg}`,
          toolFailures: failures,
        };
      }
    }

    throw new Error('Refinement loop should have returned before reaching here');
  }

  /**
   * Test generated server and stream real-time progress
   * Ideal for frontend integration
   */
  async testWithStreaming(
    generatedCode: GeneratedCode,
    onProgress: (update: any) => void,
  ): Promise<McpServerTestResult> {
    // Register progress callback
    const testId = `test-${Date.now()}`;

    this.mcpTestingService.registerProgressCallback(testId, (update) => {
      onProgress({
        ...update,
        testId,
      });
    });

    try {
      const result = await this.mcpTestingService.testMcpServer(generatedCode, {
        timeout: 120,
        toolTimeout: 5,
        cleanup: true,
      });

      return result;
    } finally {
      this.mcpTestingService.unregisterProgressCallback(testId);
    }
  }

  /**
   * Analyze test failures and categorize by severity
   */
  private analyzeTestFailures(
    testResult: McpServerTestResult,
  ): Array<{
    toolName: string;
    error: string;
    priority: 'HIGH' | 'MEDIUM' | 'LOW';
    category: 'build' | 'mcp_protocol' | 'runtime' | 'timeout';
  }> {
    const failures: Array<any> = [];

    // Check for build failure (highest priority)
    if (!testResult.buildSuccess) {
      failures.push({
        toolName: 'BUILD',
        error: testResult.buildError || 'Unknown build error',
        priority: 'HIGH',
        category: 'build',
      });
    }

    // Analyze individual tool failures
    for (const result of testResult.results) {
      if (!result.success) {
        let priority: 'HIGH' | 'MEDIUM' | 'LOW' = 'MEDIUM';
        let category: 'mcp_protocol' | 'runtime' | 'timeout' = 'runtime';

        if (result.error?.includes('timeout') || result.error?.includes('Timeout')) {
          priority = 'HIGH';
          category = 'timeout';
        } else if (!result.mcpCompliant) {
          priority = 'HIGH';
          category = 'mcp_protocol';
        }

        failures.push({
          toolName: result.toolName,
          error: result.error || 'Unknown error',
          priority,
          category,
        });
      }
    }

    // Sort by priority
    return failures.sort((a, b) => {
      const priorityOrder = { HIGH: 0, MEDIUM: 1, LOW: 2 };
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    });
  }

  /**
   * Build detailed feedback for regeneration
   */
  private buildRegenerationFeedback(
    testResult: McpServerTestResult,
    failures: any[],
  ): string {
    let feedback = '';

    if (!testResult.buildSuccess) {
      feedback += `Build Error:\n${testResult.buildError}\n\n`;
    }

    const protocolIssues = failures.filter((f) => f.category === 'mcp_protocol');
    if (protocolIssues.length > 0) {
      feedback += 'MCP Protocol Issues:\n';
      protocolIssues.forEach((issue) => {
        feedback += `- ${issue.toolName}: ${issue.error}\n`;
      });
      feedback += '\n';
    }

    const runtimeIssues = failures.filter((f) => f.category === 'runtime');
    if (runtimeIssues.length > 0) {
      feedback += 'Runtime Issues:\n';
      runtimeIssues.forEach((issue) => {
        feedback += `- ${issue.toolName}: ${issue.error}\n`;
      });
      feedback += '\n';
    }

    const timeoutIssues = failures.filter((f) => f.category === 'timeout');
    if (timeoutIssues.length > 0) {
      feedback += 'Timeout Issues:\n';
      timeoutIssues.forEach((issue) => {
        feedback += `- ${issue.toolName}: Tool took too long or didn't respond\n`;
      });
      feedback += '\n';
    }

    feedback += `Test Summary: ${testResult.toolsPassedCount}/${testResult.toolsTested} tools passed`;

    return feedback;
  }

  /**
   * Regenerate failed tools
   * In a real implementation, this would call McpGenerationService
   * with detailed failure feedback
   */
  private async regenerateFailedTools(
    currentCode: GeneratedCode,
    failures: any[],
    feedback: string,
  ): Promise<GeneratedCode> {
    // This is a simplified example
    // In production, you'd use McpGenerationService.regenerateToolImplementations()
    // with detailed feedback about what failed

    this.logger.log(`Regenerating ${failures.length} failed tools with feedback`);

    // TODO: Implement actual regeneration using McpGenerationService
    // const updatedCode = await this.mcpGenerationService.regenerateToolImplementations(
    //   currentCode,
    //   failures.map(f => f.toolName),
    //   feedback
    // );

    throw new Error(
      'Regeneration not yet implemented - integrate with McpGenerationService',
    );
  }
}

/**
 * Example: Using in Graph Orchestration (LangGraph node)
 *
 * This shows how to integrate testing into the refinement loop node
 */
export class RefinementLoopNodeExample {
  /**
   * Refinement loop node for LangGraph
   * Executes after code generation to validate and improve generated code
   */
  async executeRefinementNode(
    graphState: any,
    testingService: McpTestingService,
    refinementService: TestDrivenRefinementService,
  ) {
    const generatedCode = graphState.generatedCode;

    // Test with streaming progress
    const testResult = await refinementService.testWithStreaming(
      generatedCode,
      (update) => {
        // Stream update to frontend via SSE
        graphState.streamingUpdates.push({
          node: 'refinement_testing',
          message: update.message,
          timestamp: new Date(),
        });

        console.log(`[Refinement Testing] ${update.message}`);
      },
    );

    // Store test results
    graphState.refinementHistory = graphState.refinementHistory || [];
    graphState.refinementHistory.push({
      iteration: 1,
      testResults: testResult,
      timestamp: new Date(),
    });

    // Check if all tests passed
    if (testResult.overallSuccess) {
      return {
        ...graphState,
        response: `All ${testResult.toolsTested} tools tested successfully!`,
        isComplete: true,
      };
    }

    // If tests failed, return failure information
    const failedTools = testResult.results.filter((r) => !r.success);

    return {
      ...graphState,
      response: `Testing failed: ${failedTools.length} tools did not pass. Needs regeneration.`,
      needsUserInput: true, // Ask user if they want to regenerate
    };
  }
}

/**
 * Example: Frontend integration with real-time progress
 *
 * Usage in Angular/React component:
 *
 * ```typescript
 * async testGeneratedServer() {
 *   const testId = crypto.randomUUID();
 *
 *   // SSE for real-time updates
 *   const eventSource = new EventSource(`/api/testing/stream/${testId}`);
 *
 *   const progressMessage = ref('Initializing...');
 *   const toolsProgress = ref(0);
 *   const totalTools = ref(0);
 *
 *   eventSource.onmessage = (event) => {
 *     const update = JSON.parse(event.data);
 *
 *     switch (update.type) {
 *       case 'building':
 *         progressMessage.value = update.message;
 *         break;
 *       case 'testing_tool':
 *         totalTools.value = update.totalTools;
 *         toolsProgress.value = update.toolIndex;
 *         progressMessage.value = `Testing ${update.toolName}...`;
 *         break;
 *       case 'complete':
 *         progressMessage.value = update.message;
 *         eventSource.close();
 *         showTestResults(update.result);
 *         break;
 *       case 'error':
 *         progressMessage.value = `ERROR: ${update.message}`;
 *         eventSource.close();
 *         break;
 *     }
 *   };
 *
 *   eventSource.onerror = () => {
 *     progressMessage.value = 'Connection lost';
 *     eventSource.close();
 *   };
 * }
 * ```
 */
