/// <reference types="jest" />
import { Test, TestingModule } from '@nestjs/testing';
import { ClarificationService } from '../clarification.service';
import { EnvVariableService } from '../../env-variable.service';
import {
  createTestState,
  createResearchedState,
  createEnsembledState,
} from './__mocks__/test-utils';
import { mockGapDetectionResponse } from './__mocks__/anthropic.mock';
import { RequiredEnvVar } from '../types';

// Mock @langchain/anthropic module
const mockLlmInvoke = jest.fn();

jest.mock('@langchain/anthropic', () => ({
  ChatAnthropic: jest.fn().mockImplementation(() => ({
    invoke: mockLlmInvoke,
  })),
}));

describe('ClarificationService', () => {
  let service: ClarificationService;
  let mockEnvVariableService: any;

  // Store original env
  const originalEnv = process.env;

  beforeEach(async () => {
    // Reset mocks
    jest.clearAllMocks();
    mockLlmInvoke.mockResolvedValue({
      content: mockGapDetectionResponse([]),
    });

    // Set environment variables
    process.env = {
      ...originalEnv,
      ANTHROPIC_API_KEY: 'test-api-key',
    };

    mockEnvVariableService = {
      generateClarificationQuestions: jest.fn().mockReturnValue([
        {
          envVarName: 'API_KEY',
          question: 'Please provide your API key',
          context: 'Required for authentication',
          options: ['I have it', "I'll get it later"],
        },
      ]),
      validateEnvVarFormat: jest.fn().mockReturnValue({
        isValid: true,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ClarificationService,
        {
          provide: EnvVariableService,
          useValue: mockEnvVariableService,
        },
      ],
    }).compile();

    service = module.get<ClarificationService>(ClarificationService);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('orchestrateClarification', () => {
    it('should return complete when no gaps detected', async () => {
      const state = createEnsembledState();

      const result = await service.orchestrateClarification(state);

      expect(result.complete).toBe(true);
      expect(result.gaps).toHaveLength(0);
      expect(result.needsUserInput).toBe(false);
    });

    it('should detect HIGH priority gaps and ask questions', async () => {
      mockLlmInvoke.mockResolvedValue({
        content: JSON.stringify({
          gaps: [
            {
              issue: 'API base URL is completely unknown',
              priority: 'HIGH',
              suggestedQuestion: 'What is the API base URL?',
              context: 'Cannot generate without knowing the endpoint',
            },
          ],
        }),
      });

      const state = createEnsembledState();

      const result = await service.orchestrateClarification(state);

      expect(result.complete).toBe(false);
      expect(result.gaps.length).toBeGreaterThan(0);
      expect(result.gaps[0].priority).toBe('HIGH');
      expect(result.needsUserInput).toBe(true);
      expect(result.questions).toBeDefined();
    });

    it('should detect MEDIUM priority gaps', async () => {
      mockLlmInvoke.mockResolvedValue({
        content: JSON.stringify({
          gaps: [
            {
              issue: 'Rate limit not confirmed',
              priority: 'MEDIUM',
              suggestedQuestion: 'What is the rate limit?',
              context: 'For optimization',
            },
          ],
        }),
      });

      const state = createEnsembledState();

      const result = await service.orchestrateClarification(state);

      expect(result.complete).toBe(false);
      expect(result.gaps[0].priority).toBe('MEDIUM');
    });

    it('should filter out LOW priority gaps', async () => {
      mockLlmInvoke.mockResolvedValue({
        content: JSON.stringify({
          gaps: [
            {
              issue: 'Nice to have feature',
              priority: 'LOW',
              suggestedQuestion: 'Want this feature?',
              context: 'Optional',
            },
          ],
        }),
      });

      const state = createEnsembledState();

      const result = await service.orchestrateClarification(state);

      // LOW priority gaps should be filtered out
      expect(result.complete).toBe(true);
      expect(result.gaps).toHaveLength(0);
    });

    it('should return complete after max 3 clarification rounds', async () => {
      mockLlmInvoke.mockResolvedValue({
        content: JSON.stringify({
          gaps: [
            {
              issue: 'Still missing info',
              priority: 'HIGH',
              suggestedQuestion: 'Need more info?',
              context: 'Blocking',
            },
          ],
        }),
      });

      const state = createEnsembledState({
        clarificationHistory: [
          { gaps: [], questions: [], userResponses: 'A1', timestamp: new Date() },
          { gaps: [], questions: [], userResponses: 'A2', timestamp: new Date() },
          { gaps: [], questions: [], userResponses: 'A3', timestamp: new Date() },
        ],
      });

      const result = await service.orchestrateClarification(state);

      expect(result.complete).toBe(true);
      expect(result.needsUserInput).toBe(false);
    });

    it('should limit questions to 2 at a time', async () => {
      mockLlmInvoke.mockResolvedValue({
        content: JSON.stringify({
          gaps: [
            { issue: 'Gap 1', priority: 'HIGH', suggestedQuestion: 'Q1?', context: 'C1' },
            { issue: 'Gap 2', priority: 'HIGH', suggestedQuestion: 'Q2?', context: 'C2' },
            { issue: 'Gap 3', priority: 'HIGH', suggestedQuestion: 'Q3?', context: 'C3' },
            { issue: 'Gap 4', priority: 'HIGH', suggestedQuestion: 'Q4?', context: 'C4' },
          ],
        }),
      });

      const state = createEnsembledState();

      const result = await service.orchestrateClarification(state);

      expect(result.questions).toBeDefined();
      expect(result.questions!.length).toBeLessThanOrEqual(2);
    });

    it('should handle LLM errors gracefully', async () => {
      mockLlmInvoke.mockRejectedValue(new Error('LLM API failed'));

      const state = createEnsembledState();

      const result = await service.orchestrateClarification(state);

      // Should return complete on error (proceed with available info)
      expect(result.complete).toBe(true);
      expect(result.gaps).toHaveLength(0);
    });

    it('should handle invalid JSON response gracefully', async () => {
      mockLlmInvoke.mockResolvedValue({
        content: 'This is not valid JSON',
      });

      const state = createEnsembledState();

      const result = await service.orchestrateClarification(state);

      expect(result.complete).toBe(true);
      expect(result.gaps).toHaveLength(0);
    });
  });

  describe('formulate questions', () => {
    it('should sort questions by priority (HIGH first)', async () => {
      mockLlmInvoke.mockResolvedValue({
        content: JSON.stringify({
          gaps: [
            { issue: 'Low priority', priority: 'MEDIUM', suggestedQuestion: 'Q1?', context: 'C1' },
            { issue: 'High priority', priority: 'HIGH', suggestedQuestion: 'Q2?', context: 'C2' },
          ],
        }),
      });

      const state = createEnsembledState();

      const result = await service.orchestrateClarification(state);

      // HIGH priority should come first
      expect(result.questions![0].required).toBe(true);
    });

    it('should add authentication options for auth-related gaps', async () => {
      mockLlmInvoke.mockResolvedValue({
        content: JSON.stringify({
          gaps: [
            {
              issue: 'Authentication method unknown',
              priority: 'HIGH',
              suggestedQuestion: 'What authentication method?',
              context: 'Need to know auth type',
            },
          ],
        }),
      });

      const state = createEnsembledState();

      const result = await service.orchestrateClarification(state);

      expect(result.questions![0].options).toBeDefined();
      expect(result.questions![0].options).toContain('API Key');
      expect(result.questions![0].options).toContain('OAuth 2.0');
    });

    it('should add rate limit options for rate-limit gaps', async () => {
      mockLlmInvoke.mockResolvedValue({
        content: JSON.stringify({
          gaps: [
            {
              issue: 'Rate limit unknown',
              priority: 'HIGH',
              suggestedQuestion: 'What is the rate limit?',
              context: 'For throttling',
            },
          ],
        }),
      });

      const state = createEnsembledState();

      const result = await service.orchestrateClarification(state);

      expect(result.questions![0].options).toBeDefined();
      expect(result.questions![0].options).toContain('No rate limit');
    });

    it('should mark HIGH priority questions as required', async () => {
      mockLlmInvoke.mockResolvedValue({
        content: JSON.stringify({
          gaps: [
            { issue: 'Critical gap', priority: 'HIGH', suggestedQuestion: 'Q?', context: 'C' },
          ],
        }),
      });

      const state = createEnsembledState();

      const result = await service.orchestrateClarification(state);

      expect(result.questions![0].required).toBe(true);
    });

    it('should mark MEDIUM priority questions as not required', async () => {
      mockLlmInvoke.mockResolvedValue({
        content: JSON.stringify({
          gaps: [
            { issue: 'Medium gap', priority: 'MEDIUM', suggestedQuestion: 'Q?', context: 'C' },
          ],
        }),
      });

      const state = createEnsembledState();

      const result = await service.orchestrateClarification(state);

      expect(result.questions![0].required).toBe(false);
    });
  });

  describe('environment variable collection', () => {
    it('should detect when env var collection is needed', () => {
      const state = createEnsembledState({
        detectedEnvVars: [
          { name: 'API_KEY', required: true, description: 'API key' } as RequiredEnvVar,
        ],
        collectedEnvVars: [],
      });

      const result = service.needsEnvVarCollection(state);

      expect(result).toBe(true);
    });

    it('should return false when all env vars collected', () => {
      const state = createEnsembledState({
        detectedEnvVars: [
          { name: 'API_KEY', required: true, description: 'API key' } as RequiredEnvVar,
        ],
        collectedEnvVars: [
          { name: 'API_KEY', value: 'sk-test', validated: true, skipped: false },
        ],
      });

      const result = service.needsEnvVarCollection(state);

      expect(result).toBe(false);
    });

    it('should return false when no env vars detected', () => {
      const state = createEnsembledState({
        detectedEnvVars: [],
        collectedEnvVars: [],
      });

      const result = service.needsEnvVarCollection(state);

      expect(result).toBe(false);
    });

    it('should only check required env vars', () => {
      const state = createEnsembledState({
        detectedEnvVars: [
          { name: 'OPTIONAL_KEY', required: false, description: 'Optional' } as RequiredEnvVar,
        ],
        collectedEnvVars: [],
      });

      const result = service.needsEnvVarCollection(state);

      expect(result).toBe(false);
    });
  });

  describe('generateEnvVarQuestions', () => {
    it('should generate questions for uncollected env vars', async () => {
      const state = createEnsembledState({
        detectedEnvVars: [
          { name: 'API_KEY', required: true, description: 'API key' } as RequiredEnvVar,
        ],
        collectedEnvVars: [],
      });

      const result = await service.generateEnvVarQuestions(state);

      expect(result.complete).toBe(false);
      expect(result.questions.length).toBeGreaterThan(0);
      expect(result.needsUserInput).toBe(true);
      expect(mockEnvVariableService.generateClarificationQuestions).toHaveBeenCalled();
    });

    it('should return complete when all env vars collected', async () => {
      const state = createEnsembledState({
        detectedEnvVars: [
          { name: 'API_KEY', required: true, description: 'API key' } as RequiredEnvVar,
        ],
        collectedEnvVars: [
          { name: 'API_KEY', value: 'sk-test', validated: true, skipped: false },
        ],
      });

      const result = await service.generateEnvVarQuestions(state);

      expect(result.complete).toBe(true);
      expect(result.questions).toHaveLength(0);
      expect(result.needsUserInput).toBe(false);
    });

    it('should limit questions to 2 at a time', async () => {
      mockEnvVariableService.generateClarificationQuestions.mockReturnValue([
        { envVarName: 'VAR1', question: 'Q1?', context: 'C1' },
        { envVarName: 'VAR2', question: 'Q2?', context: 'C2' },
        { envVarName: 'VAR3', question: 'Q3?', context: 'C3' },
      ]);

      const state = createEnsembledState({
        detectedEnvVars: [
          { name: 'VAR1', required: true, description: 'Var 1' } as RequiredEnvVar,
          { name: 'VAR2', required: true, description: 'Var 2' } as RequiredEnvVar,
          { name: 'VAR3', required: true, description: 'Var 3' } as RequiredEnvVar,
        ],
        collectedEnvVars: [],
      });

      const result = await service.generateEnvVarQuestions(state);

      expect(result.questions.length).toBeLessThanOrEqual(2);
      expect(result.envVarNames.length).toBeLessThanOrEqual(2);
    });

    it('should include env var names in response', async () => {
      const state = createEnsembledState({
        detectedEnvVars: [
          { name: 'API_KEY', required: true, description: 'API key' } as RequiredEnvVar,
        ],
        collectedEnvVars: [],
      });

      const result = await service.generateEnvVarQuestions(state);

      expect(result.envVarNames).toContain('API_KEY');
    });
  });

  describe('processEnvVarResponse', () => {
    it('should validate and store env var value', () => {
      const state = createEnsembledState({
        collectedEnvVars: [],
      });

      const result = service.processEnvVarResponse('API_KEY', 'sk-test-123', state);

      expect(result.collectedEnvVars).toHaveLength(1);
      expect(result.collectedEnvVars[0].name).toBe('API_KEY');
      expect(result.collectedEnvVars[0].value).toBe('sk-test-123');
      expect(result.collectedEnvVars[0].skipped).toBe(false);
      expect(mockEnvVariableService.validateEnvVarFormat).toHaveBeenCalledWith(
        'API_KEY',
        'sk-test-123',
      );
    });

    it('should handle skipped env vars', () => {
      const state = createEnsembledState({
        collectedEnvVars: [],
      });

      const result = service.processEnvVarResponse('API_KEY', 'skip', state);

      expect(result.collectedEnvVars[0].skipped).toBe(true);
      expect(result.collectedEnvVars[0].value).toBe('');
    });

    it('should handle empty value as skipped', () => {
      const state = createEnsembledState({
        collectedEnvVars: [],
      });

      const result = service.processEnvVarResponse('API_KEY', '', state);

      expect(result.collectedEnvVars[0].skipped).toBe(true);
    });

    it('should return validation errors', () => {
      mockEnvVariableService.validateEnvVarFormat.mockReturnValue({
        isValid: false,
        errorMessage: 'Invalid API key format',
      });

      const state = createEnsembledState({
        collectedEnvVars: [],
      });

      const result = service.processEnvVarResponse('API_KEY', 'invalid', state);

      expect(result.validationResult.isValid).toBe(false);
      expect(result.validationResult.errorMessage).toBe('Invalid API key format');
    });

    it('should append to existing collected vars', () => {
      const state = createEnsembledState({
        collectedEnvVars: [
          { name: 'EXISTING', value: 'value', validated: true, skipped: false },
        ],
      });

      const result = service.processEnvVarResponse('NEW_VAR', 'new-value', state);

      expect(result.collectedEnvVars).toHaveLength(2);
      expect(result.collectedEnvVars[0].name).toBe('EXISTING');
      expect(result.collectedEnvVars[1].name).toBe('NEW_VAR');
    });
  });

  describe('createEnvVarGaps', () => {
    it('should convert required env vars to knowledge gaps', () => {
      const envVars: RequiredEnvVar[] = [
        {
          name: 'API_KEY',
          required: true,
          description: 'API authentication key',
          sensitive: true,
          category: 'authentication',
        },
      ];

      const gaps = service.createEnvVarGaps(envVars);

      expect(gaps).toHaveLength(1);
      expect(gaps[0].priority).toBe('HIGH');
      expect(gaps[0].issue).toContain('API authentication key');
      expect(gaps[0].context).toContain('securely stored');
    });

    it('should filter out non-required env vars', () => {
      const envVars: RequiredEnvVar[] = [
        { name: 'REQUIRED', required: true, description: 'Required var', category: 'authentication', sensitive: true },
        { name: 'OPTIONAL', required: false, description: 'Optional var', category: 'general', sensitive: false },
      ];

      const gaps = service.createEnvVarGaps(envVars);

      expect(gaps).toHaveLength(1);
      expect(gaps[0].issue).toContain('Required var');
    });

    it('should include documentation URL in question when available', () => {
      const envVars: RequiredEnvVar[] = [
        {
          name: 'API_KEY',
          required: true,
          description: 'API key',
          documentationUrl: 'https://docs.example.com/api-keys',
          category: 'authentication',
          sensitive: true,
        },
      ];

      const gaps = service.createEnvVarGaps(envVars);

      expect(gaps[0].suggestedQuestion).toContain('https://docs.example.com/api-keys');
    });

    it('should return empty array for empty input', () => {
      const gaps = service.createEnvVarGaps([]);
      expect(gaps).toHaveLength(0);
    });
  });

  describe('gap detection prompt', () => {
    it('should include platform context in prompt', async () => {
      const state = createEnsembledState();

      await service.orchestrateClarification(state);

      expect(mockLlmInvoke).toHaveBeenCalled();
      const prompt = mockLlmInvoke.mock.calls[0][0];
      expect(prompt).toContain('MCP Everything');
    });

    it('should include research findings in prompt', async () => {
      const state = createEnsembledState();
      state.researchPhase!.synthesizedPlan!.summary = 'Test API research summary';

      await service.orchestrateClarification(state);

      const prompt = mockLlmInvoke.mock.calls[0][0];
      expect(prompt).toContain('Test API research summary');
    });

    it('should include ensemble results in prompt', async () => {
      const state = createEnsembledState();
      state.ensembleResults!.consensusScore = 0.75;

      await service.orchestrateClarification(state);

      const prompt = mockLlmInvoke.mock.calls[0][0];
      expect(prompt).toContain('0.75');
    });

    it('should include clarification history count in prompt', async () => {
      const state = createEnsembledState({
        clarificationHistory: [
          { gaps: [], questions: [], userResponses: 'A1', timestamp: new Date() },
        ],
      });

      await service.orchestrateClarification(state);

      const prompt = mockLlmInvoke.mock.calls[0][0];
      expect(prompt).toContain('1 rounds completed');
    });
  });
});
