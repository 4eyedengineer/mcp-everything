/// <reference types="jest" />
import { Test, TestingModule } from '@nestjs/testing';
import { EnsembleService } from '../ensemble.service';
import { createResearchedState } from './__mocks__/test-utils';
import {
  mockEnsembleAgentResponse,
  mockConflictResolutionResponse,
} from './__mocks__/anthropic.mock';

// Mock file system for prompt loading
jest.mock('fs/promises', () => ({
  readFile: jest.fn().mockResolvedValue(
    JSON.stringify({
      architectAgent: {
        weight: 1.0,
        systemPrompt: 'You are an architect agent focusing on design quality.',
      },
      securityAgent: {
        weight: 0.8,
        systemPrompt: 'You are a security agent focusing on validations.',
      },
      performanceAgent: {
        weight: 0.8,
        systemPrompt: 'You are a performance agent focusing on optimization.',
      },
      mcpSpecialistAgent: {
        weight: 1.2,
        systemPrompt: 'You are an MCP specialist focusing on protocol compliance.',
      },
    }),
  ),
}));

// Mock @langchain/anthropic module
const mockLlmInvoke = jest.fn();

jest.mock('@langchain/anthropic', () => ({
  ChatAnthropic: jest.fn().mockImplementation(() => ({
    invoke: mockLlmInvoke,
  })),
}));

describe('EnsembleService', () => {
  let service: EnsembleService;

  // Store original env
  const originalEnv = process.env;

  beforeEach(async () => {
    // Reset mocks
    jest.clearAllMocks();
    mockLlmInvoke.mockResolvedValue({
      content: mockEnsembleAgentResponse(3),
    });

    // Set environment variables
    process.env = {
      ...originalEnv,
      ANTHROPIC_API_KEY: 'test-api-key',
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [EnsembleService],
    }).compile();

    service = module.get<EnsembleService>(EnsembleService);

    // Wait for async initialization
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('orchestrateEnsemble', () => {
    it('should run 4 agents in parallel', async () => {
      const state = createResearchedState();

      const result = await service.orchestrateEnsemble(state);

      // Should have invoked LLM at least 4 times (once per agent)
      // May have additional calls for conflict resolution
      expect(mockLlmInvoke.mock.calls.length).toBeGreaterThanOrEqual(4);
      expect(result.agentPerspectives).toHaveLength(4);
    });

    it('should return perspectives from all agents', async () => {
      const state = createResearchedState();

      const result = await service.orchestrateEnsemble(state);

      const agentNames = result.agentPerspectives.map((p) => p.agentName);
      expect(agentNames).toContain('architect');
      expect(agentNames).toContain('security');
      expect(agentNames).toContain('performance');
      expect(agentNames).toContain('mcpSpecialist');
    });

    it('should assign correct weights to agents', async () => {
      const state = createResearchedState();

      const result = await service.orchestrateEnsemble(state);

      const architect = result.agentPerspectives.find((p) => p.agentName === 'architect');
      const security = result.agentPerspectives.find((p) => p.agentName === 'security');
      const performance = result.agentPerspectives.find(
        (p) => p.agentName === 'performance',
      );
      const mcpSpecialist = result.agentPerspectives.find(
        (p) => p.agentName === 'mcpSpecialist',
      );

      expect(architect?.weight).toBe(1.0);
      expect(security?.weight).toBe(0.8);
      expect(performance?.weight).toBe(0.8);
      expect(mcpSpecialist?.weight).toBe(1.2);
    });

    it('should return consensus generation plan', async () => {
      const state = createResearchedState();

      const result = await service.orchestrateEnsemble(state);

      expect(result.consensus).toBeDefined();
      expect(result.consensus.steps).toBeDefined();
      expect(result.consensus.toolsToGenerate).toBeDefined();
      expect(result.consensus.estimatedComplexity).toBeDefined();
    });

    it('should calculate consensus score', async () => {
      const state = createResearchedState();

      const result = await service.orchestrateEnsemble(state);

      expect(result.consensusScore).toBeGreaterThanOrEqual(0);
      expect(result.consensusScore).toBeLessThanOrEqual(1);
    });

    it('should resolve conflicts when consensus < 0.7', async () => {
      // Mock agents returning different tools with low confidence
      mockLlmInvoke
        .mockResolvedValueOnce({
          content: JSON.stringify({
            recommendations: { tools: [], reasoning: 'No tools', concerns: [] },
            confidence: 0.3,
          }),
        })
        .mockResolvedValueOnce({
          content: JSON.stringify({
            recommendations: { tools: [], reasoning: 'No tools', concerns: [] },
            confidence: 0.3,
          }),
        })
        .mockResolvedValueOnce({
          content: JSON.stringify({
            recommendations: { tools: [], reasoning: 'No tools', concerns: [] },
            confidence: 0.3,
          }),
        })
        .mockResolvedValueOnce({
          content: JSON.stringify({
            recommendations: { tools: [], reasoning: 'No tools', concerns: [] },
            confidence: 0.3,
          }),
        })
        .mockResolvedValueOnce({
          content: mockConflictResolutionResponse(3),
        });

      const state = createResearchedState();

      const result = await service.orchestrateEnsemble(state);

      expect(result.conflictsResolved).toBe(true);
    });

    it('should respect user tool count constraints', async () => {
      const state = createResearchedState({
        requestedToolCount: 2,
        maxToolCount: 4,
      });

      const result = await service.orchestrateEnsemble(state);

      expect(result.consensus.toolsToGenerate.length).toBeLessThanOrEqual(4);
    });

    it('should respect user tool name constraints', async () => {
      mockLlmInvoke.mockResolvedValue({
        content: JSON.stringify({
          recommendations: {
            tools: [
              {
                name: 'get_users',
                description: 'Get users',
                inputSchema: { type: 'object', properties: {} },
                outputFormat: 'JSON',
                priority: 'high',
                estimatedComplexity: 'simple',
              },
              {
                name: 'create_user',
                description: 'Create user',
                inputSchema: { type: 'object', properties: {} },
                outputFormat: 'JSON',
                priority: 'high',
                estimatedComplexity: 'simple',
              },
              {
                name: 'delete_user',
                description: 'Delete user',
                inputSchema: { type: 'object', properties: {} },
                outputFormat: 'JSON',
                priority: 'medium',
                estimatedComplexity: 'simple',
              },
            ],
            reasoning: 'User management tools',
            concerns: [],
          },
          confidence: 0.9,
        }),
      });

      const state = createResearchedState({
        requestedToolNames: ['get_users', 'create_user'],
        requestedToolCount: 2,
        maxToolCount: 4,
      });

      const result = await service.orchestrateEnsemble(state);

      const toolNames = result.consensus.toolsToGenerate.map((t) => t.name);
      expect(toolNames).toContain('get_users');
      expect(toolNames).toContain('create_user');
    });
  });

  describe('agent invocation', () => {
    it('should handle agent invocation errors gracefully', async () => {
      mockLlmInvoke
        .mockRejectedValueOnce(new Error('Architect agent failed'))
        .mockResolvedValue({
          content: mockEnsembleAgentResponse(2),
        });

      const state = createResearchedState();

      // Should not throw, should return fallback
      const result = await service.orchestrateEnsemble(state);

      expect(result.agentPerspectives).toHaveLength(4);
      // The failed agent should have low confidence and empty tools
      const architect = result.agentPerspectives.find((p) => p.agentName === 'architect');
      expect(architect?.confidence).toBe(0.3);
      expect(architect?.recommendations.tools).toHaveLength(0);
    });

    it('should handle invalid JSON response from agent', async () => {
      mockLlmInvoke
        .mockResolvedValueOnce({
          content: 'This is not valid JSON',
        })
        .mockResolvedValue({
          content: mockEnsembleAgentResponse(2),
        });

      const state = createResearchedState();

      const result = await service.orchestrateEnsemble(state);

      // Should complete without throwing
      expect(result.agentPerspectives).toHaveLength(4);
    });
  });

  describe('voting aggregation', () => {
    it('should collect votes from all agents', async () => {
      const state = createResearchedState();

      const result = await service.orchestrateEnsemble(state);

      expect(result.votingDetails.totalVotes).toBeGreaterThan(0);
    });

    it('should apply weighted voting algorithm', async () => {
      // MCP specialist has highest weight (1.2), so its recommendations
      // should have more influence on consensus
      mockLlmInvoke
        .mockResolvedValueOnce({
          content: JSON.stringify({
            recommendations: {
              tools: [{ name: 'architect_tool', description: 'Architect tool', inputSchema: {}, outputFormat: 'JSON', priority: 'high', estimatedComplexity: 'simple' }],
              reasoning: 'Architect perspective',
              concerns: [],
            },
            confidence: 0.7,
          }),
        })
        .mockResolvedValueOnce({
          content: JSON.stringify({
            recommendations: {
              tools: [{ name: 'security_tool', description: 'Security tool', inputSchema: {}, outputFormat: 'JSON', priority: 'high', estimatedComplexity: 'simple' }],
              reasoning: 'Security perspective',
              concerns: [],
            },
            confidence: 0.7,
          }),
        })
        .mockResolvedValueOnce({
          content: JSON.stringify({
            recommendations: {
              tools: [{ name: 'performance_tool', description: 'Performance tool', inputSchema: {}, outputFormat: 'JSON', priority: 'high', estimatedComplexity: 'simple' }],
              reasoning: 'Performance perspective',
              concerns: [],
            },
            confidence: 0.7,
          }),
        })
        .mockResolvedValueOnce({
          content: JSON.stringify({
            recommendations: {
              tools: [{ name: 'mcp_tool', description: 'MCP tool', inputSchema: {}, outputFormat: 'JSON', priority: 'high', estimatedComplexity: 'simple' }],
              reasoning: 'MCP specialist perspective',
              concerns: [],
            },
            confidence: 0.95,
          }),
        })
        .mockResolvedValueOnce({
          content: mockConflictResolutionResponse(4),
        });

      const state = createResearchedState();

      const result = await service.orchestrateEnsemble(state);

      // Should have voting details
      expect(result.votingDetails).toBeDefined();
    });

    it('should filter tools with score < 0.7 when consensus reached', async () => {
      // All agents return same tools with high confidence - consensus reached
      mockLlmInvoke.mockResolvedValue({
        content: JSON.stringify({
          recommendations: {
            tools: [
              { name: 'common_tool', description: 'Common tool', inputSchema: {}, outputFormat: 'JSON', priority: 'high', estimatedComplexity: 'simple' },
            ],
            reasoning: 'All agree',
            concerns: [],
          },
          confidence: 0.9,
        }),
      });

      const state = createResearchedState();

      const result = await service.orchestrateEnsemble(state);

      // Should have consensus tools
      expect(result.consensus.toolsToGenerate.length).toBeGreaterThan(0);
    });
  });

  describe('conflict resolution', () => {
    it('should use AI mediator to resolve conflicts', async () => {
      // Mock agents returning different tools with no overlap
      mockLlmInvoke
        .mockResolvedValueOnce({
          content: JSON.stringify({
            recommendations: { tools: [], reasoning: 'No tools', concerns: [] },
            confidence: 0.3,
          }),
        })
        .mockResolvedValueOnce({
          content: JSON.stringify({
            recommendations: { tools: [], reasoning: 'No tools', concerns: [] },
            confidence: 0.3,
          }),
        })
        .mockResolvedValueOnce({
          content: JSON.stringify({
            recommendations: { tools: [], reasoning: 'No tools', concerns: [] },
            confidence: 0.3,
          }),
        })
        .mockResolvedValueOnce({
          content: JSON.stringify({
            recommendations: { tools: [], reasoning: 'No tools', concerns: [] },
            confidence: 0.3,
          }),
        })
        .mockResolvedValueOnce({
          content: mockConflictResolutionResponse(5),
        });

      const state = createResearchedState();

      const result = await service.orchestrateEnsemble(state);

      expect(result.conflictsResolved).toBe(true);
      // Should have synthesized tools from mediator
      expect(result.consensus.toolsToGenerate.length).toBeGreaterThan(0);
    });

    it('should fallback to highest-weighted agent when mediator fails', async () => {
      // Mock agents returning tools, then mediator fails
      mockLlmInvoke
        .mockResolvedValueOnce({
          content: JSON.stringify({
            recommendations: { tools: [], reasoning: 'No tools', concerns: [] },
            confidence: 0.3,
          }),
        })
        .mockResolvedValueOnce({
          content: JSON.stringify({
            recommendations: { tools: [], reasoning: 'No tools', concerns: [] },
            confidence: 0.3,
          }),
        })
        .mockResolvedValueOnce({
          content: JSON.stringify({
            recommendations: { tools: [], reasoning: 'No tools', concerns: [] },
            confidence: 0.3,
          }),
        })
        .mockResolvedValueOnce({
          content: JSON.stringify({
            recommendations: {
              tools: [
                { name: 'mcp_tool', description: 'MCP tool', inputSchema: {}, outputFormat: 'JSON', priority: 'high', estimatedComplexity: 'simple' },
              ],
              reasoning: 'MCP specialist',
              concerns: [],
            },
            confidence: 0.8,
          }),
        })
        .mockRejectedValueOnce(new Error('Mediator failed'));

      const state = createResearchedState();

      const result = await service.orchestrateEnsemble(state);

      // Should fallback to MCP specialist's tools (highest weight)
      expect(result.consensus.toolsToGenerate.length).toBeGreaterThan(0);
    });
  });

  describe('enforceToolConstraints', () => {
    it('should cap tools at maxToolCount', async () => {
      mockLlmInvoke.mockResolvedValue({
        content: JSON.stringify({
          recommendations: {
            tools: Array.from({ length: 15 }, (_, i) => ({
              name: `tool_${i + 1}`,
              description: `Tool ${i + 1}`,
              inputSchema: {},
              outputFormat: 'JSON',
              priority: 'medium',
              estimatedComplexity: 'simple',
            })),
            reasoning: 'Many tools',
            concerns: [],
          },
          confidence: 0.9,
        }),
      });

      const state = createResearchedState({
        requestedToolCount: 5,
        maxToolCount: 7,
      });

      const result = await service.orchestrateEnsemble(state);

      expect(result.consensus.toolsToGenerate.length).toBeLessThanOrEqual(7);
    });

    it('should prioritize requested tool names', async () => {
      mockLlmInvoke.mockResolvedValue({
        content: JSON.stringify({
          recommendations: {
            tools: [
              { name: 'get_users', description: 'Get users', inputSchema: {}, outputFormat: 'JSON', priority: 'low', estimatedComplexity: 'simple' },
              { name: 'delete_users', description: 'Delete users', inputSchema: {}, outputFormat: 'JSON', priority: 'high', estimatedComplexity: 'simple' },
              { name: 'update_users', description: 'Update users', inputSchema: {}, outputFormat: 'JSON', priority: 'high', estimatedComplexity: 'simple' },
            ],
            reasoning: 'User tools',
            concerns: [],
          },
          confidence: 0.9,
        }),
      });

      const state = createResearchedState({
        requestedToolNames: ['get_users'],
        requestedToolCount: 1,
        maxToolCount: 3,
      });

      const result = await service.orchestrateEnsemble(state);

      const toolNames = result.consensus.toolsToGenerate.map((t) => t.name);
      expect(toolNames).toContain('get_users');
    });

    it('should create placeholder for missing requested tools', async () => {
      mockLlmInvoke.mockResolvedValue({
        content: JSON.stringify({
          recommendations: {
            tools: [
              { name: 'other_tool', description: 'Other tool', inputSchema: {}, outputFormat: 'JSON', priority: 'high', estimatedComplexity: 'simple' },
            ],
            reasoning: 'Different tool',
            concerns: [],
          },
          confidence: 0.9,
        }),
      });

      const state = createResearchedState({
        requestedToolNames: ['specific_tool'],
        requestedToolCount: 1,
        maxToolCount: 3,
      });

      const result = await service.orchestrateEnsemble(state);

      const toolNames = result.consensus.toolsToGenerate.map((t) => t.name);
      expect(toolNames).toContain('specific_tool');
    });

    it('should return capped tools when no constraints specified', async () => {
      mockLlmInvoke.mockResolvedValue({
        content: JSON.stringify({
          recommendations: {
            tools: Array.from({ length: 20 }, (_, i) => ({
              name: `tool_${i + 1}`,
              description: `Tool ${i + 1}`,
              inputSchema: {},
              outputFormat: 'JSON',
              priority: 'medium',
              estimatedComplexity: 'simple',
            })),
            reasoning: 'Many tools',
            concerns: [],
          },
          confidence: 0.9,
        }),
      });

      const state = createResearchedState();

      const result = await service.orchestrateEnsemble(state);

      // Default cap is 10 tools
      expect(result.consensus.toolsToGenerate.length).toBeLessThanOrEqual(10);
    });
  });

  describe('complexity estimation', () => {
    it('should estimate simple complexity for few simple tools', async () => {
      mockLlmInvoke.mockResolvedValue({
        content: JSON.stringify({
          recommendations: {
            tools: [
              { name: 'tool1', description: 'Tool 1', inputSchema: {}, outputFormat: 'JSON', priority: 'high', estimatedComplexity: 'simple' },
              { name: 'tool2', description: 'Tool 2', inputSchema: {}, outputFormat: 'JSON', priority: 'high', estimatedComplexity: 'simple' },
            ],
            reasoning: 'Simple tools',
            concerns: [],
          },
          confidence: 0.9,
        }),
      });

      const state = createResearchedState();

      const result = await service.orchestrateEnsemble(state);

      expect(result.consensus.estimatedComplexity).toBe('simple');
    });

    it('should estimate complex complexity for many complex tools', async () => {
      mockLlmInvoke.mockResolvedValue({
        content: JSON.stringify({
          recommendations: {
            tools: Array.from({ length: 10 }, (_, i) => ({
              name: `tool_${i + 1}`,
              description: `Complex tool ${i + 1}`,
              inputSchema: {},
              outputFormat: 'JSON',
              priority: 'high',
              estimatedComplexity: 'complex',
            })),
            reasoning: 'Complex tools',
            concerns: [],
          },
          confidence: 0.9,
        }),
      });

      const state = createResearchedState();

      const result = await service.orchestrateEnsemble(state);

      expect(result.consensus.estimatedComplexity).toBe('complex');
    });

    it('should estimate moderate complexity for mixed tools', async () => {
      mockLlmInvoke.mockResolvedValue({
        content: JSON.stringify({
          recommendations: {
            tools: [
              { name: 'tool1', description: 'Simple', inputSchema: {}, outputFormat: 'JSON', priority: 'high', estimatedComplexity: 'simple' },
              { name: 'tool2', description: 'Simple', inputSchema: {}, outputFormat: 'JSON', priority: 'high', estimatedComplexity: 'simple' },
              { name: 'tool3', description: 'Simple', inputSchema: {}, outputFormat: 'JSON', priority: 'high', estimatedComplexity: 'simple' },
              { name: 'tool4', description: 'Simple', inputSchema: {}, outputFormat: 'JSON', priority: 'high', estimatedComplexity: 'simple' },
              { name: 'tool5', description: 'Simple', inputSchema: {}, outputFormat: 'JSON', priority: 'high', estimatedComplexity: 'simple' },
              { name: 'tool6', description: 'Simple', inputSchema: {}, outputFormat: 'JSON', priority: 'high', estimatedComplexity: 'simple' },
            ],
            reasoning: 'Mixed tools',
            concerns: [],
          },
          confidence: 0.9,
        }),
      });

      const state = createResearchedState();

      const result = await service.orchestrateEnsemble(state);

      expect(result.consensus.estimatedComplexity).toBe('moderate');
    });
  });

  describe('generation steps', () => {
    it('should generate appropriate implementation steps', async () => {
      const state = createResearchedState();

      const result = await service.orchestrateEnsemble(state);

      expect(result.consensus.steps).toContain('Setup MCP server project structure');
      expect(result.consensus.steps).toContain(
        'Install dependencies and configure TypeScript',
      );
      expect(result.consensus.steps.some((s) => s.includes('Implement'))).toBe(true);
      expect(result.consensus.steps).toContain('Build and validate MCP server');
    });
  });
});
