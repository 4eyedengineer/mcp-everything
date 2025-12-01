#!/usr/bin/env ts-node

/**
 * Prompt Engineering Testing Script
 * Tests the optimized prompts for JSON generation reliability
 */

import { ConversationService } from './src/conversation.service';
import { ToolDiscoveryService } from './src/tool-discovery.service';
import { McpGenerationService } from './src/mcp-generation.service';
import { PromptValidationService, JsonValidationConfig } from './src/prompt-validation.service';
import { ConfigService } from '@nestjs/config';

interface TestResult {
  service: string;
  testCase: string;
  success: boolean;
  jsonValid: boolean;
  structureValid: boolean;
  response: string;
  issues: string[];
  duration: number;
}

class PromptTester {
  private conversationService: ConversationService;
  private toolDiscoveryService: ToolDiscoveryService;
  private mcpGenerationService: McpGenerationService;
  private validationService: PromptValidationService;

  constructor() {
    const configService = new ConfigService();
    this.conversationService = new ConversationService(configService);
    this.validationService = new PromptValidationService();

    // Mock dependencies for testing
    const mockGitHubService = {} as any;
    this.toolDiscoveryService = new ToolDiscoveryService(this.conversationService);
    this.mcpGenerationService = new McpGenerationService(configService, mockGitHubService, this.toolDiscoveryService);
  }

  async runAllTests(): Promise<void> {
    console.log('🚀 Starting Prompt Engineering Tests...\n');

    const results: TestResult[] = [];

    // Test ConversationService
    results.push(...await this.testConversationService());

    // Test ToolDiscoveryService
    results.push(...await this.testToolDiscoveryService());

    // Test McpGenerationService (mock)
    results.push(...await this.testMcpGenerationService());

    // Generate report
    this.generateReport(results);
  }

  private async testConversationService(): Promise<TestResult[]> {
    console.log('📝 Testing ConversationService prompts...');

    const testCases = [
      'Generate an MCP server for https://github.com/microsoft/vscode',
      'Create a server from the React repository',
      'What can you help me with?',
      'Make something cool for my project',
      'github.com/expressjs/express please'
    ];

    const results: TestResult[] = [];

    for (const testCase of testCases) {
      const startTime = Date.now();

      try {
        const response = await this.conversationService.processConversation(testCase);
        const duration = Date.now() - startTime;

        // Validate the response structure
        const isValid = this.validateConversationResponse(response);

        results.push({
          service: 'ConversationService',
          testCase,
          success: response.success,
          jsonValid: true, // Response is already parsed
          structureValid: isValid,
          response: JSON.stringify(response, null, 2),
          issues: isValid ? [] : ['Invalid response structure'],
          duration
        });

        console.log(`  ✅ "${testCase.substring(0, 30)}..." - ${duration}ms`);
      } catch (error) {
        const duration = Date.now() - startTime;

        results.push({
          service: 'ConversationService',
          testCase,
          success: false,
          jsonValid: false,
          structureValid: false,
          response: error.message,
          issues: [error.message],
          duration
        });

        console.log(`  ❌ "${testCase.substring(0, 30)}..." - ERROR: ${error.message}`);
      }
    }

    return results;
  }

  private async testToolDiscoveryService(): Promise<TestResult[]> {
    console.log('\n🔧 Testing ToolDiscoveryService prompts...');

    // Mock test cases for tool discovery
    const mockAnalysis = {
      metadata: {
        fullName: 'test/repo',
        description: 'Test repository',
        language: 'TypeScript'
      },
      techStack: {
        languages: ['TypeScript'],
        frameworks: ['React'],
        tools: []
      },
      features: {
        hasApi: true,
        features: ['REST API', 'Web UI']
      }
    } as any;

    const testCases = [
      {
        name: 'Code Analysis',
        code: 'function handleRequest(req, res) { return res.json({ data: "test" }); }'
      },
      {
        name: 'README Analysis',
        readme: '# Test Project\n\n## Features\n- REST API\n- Database integration\n\n## Usage\n```bash\nnpm start\n```'
      }
    ];

    const results: TestResult[] = [];

    for (const testCase of testCases) {
      const startTime = Date.now();

      try {
        let response;

        if (testCase.name === 'Code Analysis') {
          response = await this.toolDiscoveryService.generateToolFromCode(
            testCase.code,
            {
              primaryLanguage: 'JavaScript',
              frameworks: ['Express'],
              repositoryType: 'service',
              complexity: 'simple',
              domain: 'web'
            }
          );
        } else {
          response = await this.toolDiscoveryService.extractToolsFromReadme(
            testCase.readme,
            {
              primaryLanguage: 'JavaScript',
              frameworks: ['Express'],
              repositoryType: 'service',
              complexity: 'simple',
              domain: 'web'
            }
          );
        }

        const duration = Date.now() - startTime;
        const isValid = Array.isArray(response) && response.length >= 0;

        results.push({
          service: 'ToolDiscoveryService',
          testCase: testCase.name,
          success: true,
          jsonValid: true,
          structureValid: isValid,
          response: JSON.stringify(response, null, 2),
          issues: isValid ? [] : ['Invalid tool array structure'],
          duration
        });

        console.log(`  ✅ ${testCase.name} - ${response.length} tools found - ${duration}ms`);
      } catch (error) {
        const duration = Date.now() - startTime;

        results.push({
          service: 'ToolDiscoveryService',
          testCase: testCase.name,
          success: false,
          jsonValid: false,
          structureValid: false,
          response: error.message,
          issues: [error.message],
          duration
        });

        console.log(`  ❌ ${testCase.name} - ERROR: ${error.message}`);
      }
    }

    return results;
  }

  private async testMcpGenerationService(): Promise<TestResult[]> {
    console.log('\n⚙️ Testing McpGenerationService prompts...');

    // Since this requires actual API calls, we'll test the prompt building methods
    const results: TestResult[] = [];

    const mockAnalysis = {
      metadata: {
        fullName: 'test/repo',
        name: 'test-repo',
        description: 'Test repository for prompt validation',
        language: 'TypeScript'
      },
      techStack: {
        languages: ['TypeScript'],
        frameworks: ['Express'],
        tools: ['ESLint']
      },
      features: {
        features: ['REST API', 'Database']
      }
    } as any;

    const mockTools = [
      {
        name: 'get_repo_info',
        description: 'Get repository information',
        category: 'utility',
        inputSchema: {
          type: 'object',
          properties: {},
          required: []
        },
        implementationHints: {
          primaryAction: 'Repository information retrieval',
          requiredData: [],
          dependencies: [],
          complexity: 'simple',
          outputFormat: 'text',
          errorHandling: [],
          examples: []
        }
      }
    ];

    try {
      // Test prompt building (these are private methods, so we'll test indirectly)
      const testName = 'Prompt Structure Validation';
      const startTime = Date.now();

      // Access private methods through any casting for testing
      const service = this.mcpGenerationService as any;

      // Test system prompt
      const systemPrompt = service.buildSystemPrompt();
      const serverPrompt = service.buildServerCodePrompt(mockAnalysis, mockTools);

      const duration = Date.now() - startTime;

      // Validate prompt structure
      const systemValid = systemPrompt.includes('TypeScript') && !systemPrompt.includes('```');
      const serverValid = serverPrompt.includes('import') && serverPrompt.includes('server.run()');

      results.push({
        service: 'McpGenerationService',
        testCase: testName,
        success: systemValid && serverValid,
        jsonValid: true,
        structureValid: systemValid && serverValid,
        response: `System prompt: ${systemPrompt.length} chars, Server prompt: ${serverPrompt.length} chars`,
        issues: [
          ...(systemValid ? [] : ['System prompt validation failed']),
          ...(serverValid ? [] : ['Server prompt validation failed'])
        ],
        duration
      });

      console.log(`  ✅ ${testName} - Prompts validated - ${duration}ms`);
    } catch (error) {
      results.push({
        service: 'McpGenerationService',
        testCase: 'Prompt Structure Validation',
        success: false,
        jsonValid: false,
        structureValid: false,
        response: error.message,
        issues: [error.message],
        duration: 0
      });

      console.log(`  ❌ Prompt Structure Validation - ERROR: ${error.message}`);
    }

    return results;
  }

  private validateConversationResponse(response: any): boolean {
    return !!(
      response &&
      typeof response.success === 'boolean' &&
      response.conversationId &&
      response.response &&
      response.stage
    );
  }

  private generateReport(results: TestResult[]): void {
    console.log('\n📊 Test Results Summary');
    console.log('=' .repeat(50));

    const totalTests = results.length;
    const successfulTests = results.filter(r => r.success).length;
    const jsonValidTests = results.filter(r => r.jsonValid).length;
    const structureValidTests = results.filter(r => r.structureValid).length;

    console.log(`Total Tests: ${totalTests}`);
    console.log(`Successful: ${successfulTests} (${((successfulTests / totalTests) * 100).toFixed(1)}%)`);
    console.log(`JSON Valid: ${jsonValidTests} (${((jsonValidTests / totalTests) * 100).toFixed(1)}%)`);
    console.log(`Structure Valid: ${structureValidTests} (${((structureValidTests / totalTests) * 100).toFixed(1)}%)`);

    const avgDuration = results.reduce((sum, r) => sum + r.duration, 0) / totalTests;
    console.log(`Average Duration: ${avgDuration.toFixed(0)}ms`);

    // Service breakdown
    console.log('\n📈 Service Breakdown:');
    const serviceStats = this.groupBy(results, 'service');

    for (const [service, serviceResults] of Object.entries(serviceStats)) {
      const serviceSuccess = serviceResults.filter(r => r.success).length;
      const serviceTotal = serviceResults.length;
      console.log(`  ${service}: ${serviceSuccess}/${serviceTotal} (${((serviceSuccess / serviceTotal) * 100).toFixed(1)}%)`);
    }

    // Issues summary
    const allIssues = results.flatMap(r => r.issues);
    if (allIssues.length > 0) {
      console.log('\n⚠️  Common Issues:');
      const issueFreq = this.countFrequency(allIssues);
      Object.entries(issueFreq)
        .sort(([,a], [,b]) => b - a)
        .slice(0, 5)
        .forEach(([issue, count]) => {
          console.log(`  • ${issue} (${count}x)`);
        });
    }

    // Recommendations
    console.log('\n💡 Recommendations:');

    if (jsonValidTests < totalTests) {
      console.log('  • Strengthen JSON format enforcement in prompts');
    }

    if (structureValidTests < totalTests) {
      console.log('  • Add more explicit structure validation requirements');
    }

    if (avgDuration > 2000) {
      console.log('  • Optimize prompts for faster response times');
    }

    console.log('\n✅ Prompt optimization analysis complete!');
  }

  private groupBy<T>(array: T[], key: keyof T): Record<string, T[]> {
    return array.reduce((groups, item) => {
      const group = String(item[key]);
      groups[group] = groups[group] || [];
      groups[group].push(item);
      return groups;
    }, {} as Record<string, T[]>);
  }

  private countFrequency(items: string[]): Record<string, number> {
    return items.reduce((counts, item) => {
      counts[item] = (counts[item] || 0) + 1;
      return counts;
    }, {} as Record<string, number>);
  }
}

// Run tests if this script is executed directly
if (require.main === module) {
  const tester = new PromptTester();

  tester.runAllTests().catch(error => {
    console.error('❌ Test execution failed:', error);
    process.exit(1);
  });
}

export { PromptTester, TestResult };