import { Injectable, Logger } from '@nestjs/common';
import * as ivm from 'isolated-vm';
import { CodeExecutionContext, CodeExecutionResult } from './types';

/**
 * Secure code execution service using isolated-vm
 * Executes LLM-generated code in isolated V8 contexts
 */
@Injectable()
export class CodeExecutionService {
  private readonly logger = new Logger(CodeExecutionService.name);
  private readonly DEFAULT_TIMEOUT = 5000; // 5 seconds
  private readonly DEFAULT_MEMORY_LIMIT = 128; // 128 MB

  /**
   * Execute code in isolated VM
   */
  async executeCode(context: CodeExecutionContext): Promise<CodeExecutionResult> {
    const startTime = Date.now();

    try {
      // Create isolated VM instance
      const isolate = new ivm.Isolate({
        memoryLimit: context.memoryLimit || this.DEFAULT_MEMORY_LIMIT,
      });

      // Create execution context
      const vmContext = await isolate.createContext();

      // Setup console logging capture
      const logs: string[] = [];
      const consoleLog = new ivm.Reference((message: string) => {
        logs.push(message);
      });

      await vmContext.global.set('_log', consoleLog);
      await vmContext.evalClosure(
        `
        global.console = {
          log: (...args) => _log.applySync(undefined, [args.map(a => String(a)).join(' ')]),
          error: (...args) => _log.applySync(undefined, ['ERROR: ' + args.map(a => String(a)).join(' ')]),
          warn: (...args) => _log.applySync(undefined, ['WARN: ' + args.map(a => String(a)).join(' ')]),
        };
        `,
        [],
        { timeout: 1000 },
      );

      // Execute the code with timeout
      const script = await isolate.compileScript(context.code);
      const result = await script.run(vmContext, {
        timeout: context.timeout || this.DEFAULT_TIMEOUT,
        release: true,
      });

      // Get execution result
      let output: any;
      if (result !== undefined) {
        output = await result.copy();
      }

      const executionTime = Date.now() - startTime;

      // Cleanup
      consoleLog.release();
      vmContext.release();
      isolate.dispose();

      this.logger.log(`Code executed successfully in ${executionTime}ms`);

      return {
        success: true,
        output: {
          result: output,
          logs: logs.length > 0 ? logs : undefined,
        },
        executionTime,
        memoryUsed: isolate.getHeapStatisticsSync().used_heap_size / 1024 / 1024,
      };
    } catch (error) {
      const executionTime = Date.now() - startTime;

      this.logger.error(`Code execution failed: ${error.message}`);

      return {
        success: false,
        error: error.message,
        executionTime,
      };
    }
  }

  /**
   * Execute code with predefined safe modules
   */
  async executeWithModules(
    code: string,
    allowedModules: string[] = [],
  ): Promise<CodeExecutionResult> {
    // Wrap code with module imports
    const wrappedCode = `
      ${this.buildModuleImports(allowedModules)}

      ${code}
    `;

    return this.executeCode({
      code: wrappedCode,
      timeout: this.DEFAULT_TIMEOUT,
      memoryLimit: this.DEFAULT_MEMORY_LIMIT,
      allowedModules,
    });
  }

  /**
   * Execute async code (returns Promise)
   */
  async executeAsync(context: CodeExecutionContext): Promise<CodeExecutionResult> {
    const wrappedCode = `
      (async () => {
        ${context.code}
      })();
    `;

    return this.executeCode({
      ...context,
      code: wrappedCode,
    });
  }

  /**
   * Validate code syntax without execution
   */
  async validateSyntax(code: string): Promise<{ valid: boolean; error?: string }> {
    try {
      const isolate = new ivm.Isolate({ memoryLimit: 8 });
      await isolate.compileScript(code);
      isolate.dispose();

      return { valid: true };
    } catch (error) {
      return {
        valid: false,
        error: error.message,
      };
    }
  }

  /**
   * Execute code and test assertions
   */
  async executeTests(
    code: string,
    tests: Array<{ input: any; expectedOutput: any }>,
  ): Promise<{
    success: boolean;
    passed: number;
    failed: number;
    results: Array<{ test: number; passed: boolean; output?: any; error?: string }>;
  }> {
    const results = [];
    let passed = 0;
    let failed = 0;

    for (let i = 0; i < tests.length; i++) {
      const test = tests[i];

      // Wrap code to accept input and return output
      const testCode = `
        const input = ${JSON.stringify(test.input)};
        ${code}

        // Assume the code defines a function 'run' or uses 'input'
        typeof run === 'function' ? run(input) : result;
      `;

      const result = await this.executeCode({
        code: testCode,
        timeout: this.DEFAULT_TIMEOUT,
        memoryLimit: this.DEFAULT_MEMORY_LIMIT,
      });

      if (result.success) {
        const outputMatches = JSON.stringify(result.output.result) === JSON.stringify(test.expectedOutput);

        if (outputMatches) {
          passed++;
          results.push({ test: i, passed: true, output: result.output.result });
        } else {
          failed++;
          results.push({
            test: i,
            passed: false,
            output: result.output.result,
            error: `Expected ${JSON.stringify(test.expectedOutput)}, got ${JSON.stringify(result.output.result)}`,
          });
        }
      } else {
        failed++;
        results.push({ test: i, passed: false, error: result.error });
      }
    }

    return {
      success: failed === 0,
      passed,
      failed,
      results,
    };
  }

  /**
   * Build safe module imports (limited set for security)
   */
  private buildModuleImports(modules: string[]): string {
    const allowedModules = {
      lodash: "const _ = require('lodash');",
      moment: "const moment = require('moment');",
      axios: "const axios = require('axios');",
      // Add more safe modules as needed
    };

    return modules
      .filter(mod => mod in allowedModules)
      .map(mod => allowedModules[mod])
      .join('\n');
  }
}
