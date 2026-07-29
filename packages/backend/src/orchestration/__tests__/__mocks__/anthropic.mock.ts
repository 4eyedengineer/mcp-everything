/**
 * Mock for Anthropic/Claude API
 *
 * Provides mock implementations of the AnthropicService seam (and the legacy
 * ChatAnthropic shape still used by EnsembleService) so orchestration services
 * can be tested without making real API calls.
 */

/**
 * Build a stand-in for `AnthropicService` backed by a single jest mock that
 * receives the prompt and resolves `{ content }` (the shape the old
 * `ChatAnthropic.invoke` mocks already use).
 *
 * - `completeText` resolves the raw content string.
 * - `completeStructured` parses the content as JSON and validates it against the
 *   caller's zod schema, mirroring what the real service does with the API's
 *   structured-output response.
 */
export const createMockAnthropicService = (invoke: jest.Mock) => ({
  resolveModel: (tier?: 'default' | 'small') =>
    tier === 'small' ? 'claude-haiku-4-5' : 'claude-sonnet-5',

  completeText: async (opts: any): Promise<string> => {
    const response = await invoke(opts.prompt);
    return typeof response === 'string' ? response : String(response?.content ?? '');
  },

  completeStructured: async (opts: any): Promise<any> => {
    const response = await invoke(opts.prompt);
    const raw = typeof response === 'string' ? response : String(response?.content ?? '');
    return opts.schema.parse(JSON.parse(raw));
  },
});

export const createMockChatAnthropic = (responseContent?: string) => ({
  invoke: jest.fn().mockResolvedValue({
    content: responseContent || JSON.stringify({
      intent: 'generate_mcp',
      confidence: 0.95,
      githubUrl: 'https://github.com/test/repo',
      missingInfo: null,
      reasoning: 'User wants to generate an MCP server',
    }),
  }),
});

export const mockIntentAnalysisResponse = (intent: string, confidence: number = 0.95) =>
  JSON.stringify({
    intent,
    confidence,
    githubUrl: intent === 'generate_mcp' ? 'https://github.com/test/repo' : null,
    missingInfo: null,
    reasoning: `Detected ${intent} intent with high confidence`,
  });

export const mockResearchSynthesisResponse = () =>
  JSON.stringify({
    summary: 'Test API with REST endpoints for data management',
    keyInsights: [
      'REST API with JSON responses',
      'API key authentication',
      'Rate limiting at 100 req/min',
    ],
    recommendedApproach: 'Generate TypeScript MCP server with 5 tools',
    potentialChallenges: ['Complex authentication flow'],
    confidence: 0.85,
    reasoning: 'Comprehensive research available',
  });

export const mockInputClassificationResponse = (type: string = 'SERVICE_NAME') =>
  JSON.stringify({
    type,
    confidence: 0.9,
    serviceName: 'Stripe API',
    intent: 'Generate MCP server for payment processing',
    keywords: ['stripe', 'payment', 'api'],
  });

export const mockGapDetectionResponse = (gaps: any[] = []) =>
  JSON.stringify({
    gaps,
  });

export const mockFailureAnalysisResponse = () =>
  JSON.stringify({
    failureCount: 2,
    categories: [{ type: 'runtime', count: 2 }],
    rootCauses: ['Missing error handling', 'Invalid MCP response format'],
    fixes: [
      {
        toolName: 'test_tool',
        issue: 'Missing content array in response',
        solution: 'Return { content: [{ type: "text", text: result }] }',
        priority: 'HIGH',
        codeSnippet: 'return { content: [{ type: "text", text: JSON.stringify(result) }] };',
      },
    ],
    recommendation: 'Fix MCP response format in all tools',
  });

export const mockEnsembleAgentResponse = (toolCount: number = 3) =>
  JSON.stringify({
    recommendations: {
      tools: Array.from({ length: toolCount }, (_, i) => ({
        name: `tool_${i + 1}`,
        description: `Test tool ${i + 1}`,
        inputSchema: {
          type: 'object',
          properties: {
            input: { type: 'string', description: 'Input value' },
          },
          required: ['input'],
        },
        outputFormat: 'JSON object',
        priority: 'high',
        estimatedComplexity: 'simple',
      })),
      reasoning: 'Tools recommended based on research analysis',
      concerns: ['Consider rate limiting'],
    },
    confidence: 0.85,
  });

export const mockConflictResolutionResponse = (toolCount: number = 5) =>
  JSON.stringify({
    tools: Array.from({ length: toolCount }, (_, i) => ({
      name: `resolved_tool_${i + 1}`,
      description: `Resolved tool ${i + 1}`,
      inputSchema: {
        type: 'object',
        properties: {
          input: { type: 'string' },
        },
        required: ['input'],
      },
      outputFormat: 'JSON object',
      priority: 'high',
      estimatedComplexity: 'simple',
    })),
    resolutionStrategy: 'Merged recommendations prioritizing MCP specialist',
  });

export const mockCodeGenerationResponse = () => `
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const server = new Server(
  { name: "test-mcp-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "test_tool",
      description: "A test tool",
      inputSchema: {
        type: "object",
        properties: {
          input: { type: "string", description: "Input value" },
        },
        required: ["input"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "test_tool") {
    const schema = z.object({ input: z.string() });
    const validated = schema.parse(args);
    return {
      content: [{ type: "text", text: \`Result: \${validated.input}\` }],
    };
  }

  return {
    content: [{ type: "text", text: \`Unknown tool: \${name}\` }],
    isError: true,
  };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
`;

// Structured outputs require an object root, so services are returned under a
// `services` key rather than as a bare JSON array.
export const mockServiceIdentificationResponse = () =>
  JSON.stringify({
    services: [
      { name: 'Stripe', confidence: 0.95, reasoning: 'Payment processing keywords detected' },
      { name: 'PayPal', confidence: 0.7, reasoning: 'Alternative payment service' },
    ],
  });
