import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, NotFoundException } from '@nestjs/common';
import request from 'supertest';
import { ConversationController } from './conversation.controller';
import { ConversationService } from './conversation.service';
import { DeploymentService } from '../database/services/deployment.service';
import { PipelineStatusService } from './pipeline-status.service';
import { User } from '../database/entities/user.entity';
import { Conversation } from '../database/entities/conversation.entity';

describe('ConversationController', () => {
  let controller: ConversationController;
  let conversationService: jest.Mocked<ConversationService>;
  let deploymentService: jest.Mocked<DeploymentService>;
  let pipelineStatus: PipelineStatusService;

  const mockUser = { id: 'user-123' } as User;

  const baseConversation = (overrides: Partial<Conversation> = {}): Conversation =>
    ({
      id: 'conv-1',
      userId: 'user-123',
      sessionId: 'session-1',
      messages: [],
      state: {},
      currentStage: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      isActive: true,
      ...overrides,
    }) as Conversation;

  const mockConversationService = {
    findAllByUser: jest.fn(),
    findByIdForUser: jest.fn(),
    create: jest.fn(),
    delete: jest.fn(),
    updateTitle: jest.fn(),
  };

  const mockDeploymentService = {
    getDeploymentsByConversation: jest.fn(),
    getLatestDeployment: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ConversationController],
      providers: [
        { provide: ConversationService, useValue: mockConversationService },
        { provide: DeploymentService, useValue: mockDeploymentService },
        PipelineStatusService,
      ],
    }).compile();

    controller = module.get<ConversationController>(ConversationController);
    conversationService = module.get(ConversationService);
    deploymentService = module.get(DeploymentService);
    pipelineStatus = module.get(PipelineStatusService);

    jest.clearAllMocks();
  });

  describe('getConversations', () => {
    it('marks a conversation with an actively-executing pipeline as isGenerating', async () => {
      const conv = baseConversation();
      conversationService.findAllByUser.mockResolvedValue([conv]);
      pipelineStatus.markExecuting('conv-1');

      const result = await controller.getConversations(mockUser);

      expect(result.conversations[0].isGenerating).toBe(true);
      expect(result.conversations[0].awaitingClarification).toBe(false);
    });

    it('marks a conversation with saved resumable state as awaitingClarification', async () => {
      const conv = baseConversation({
        state: { pipeline: { awaitingClarification: true, savedAt: 'x', state: {} } },
      });
      conversationService.findAllByUser.mockResolvedValue([conv]);

      const result = await controller.getConversations(mockUser);

      expect(result.conversations[0].awaitingClarification).toBe(true);
      expect(result.conversations[0].isGenerating).toBe(false);
    });

    it('marks an idle, finished conversation as neither generating nor awaiting clarification', async () => {
      const conv = baseConversation();
      conversationService.findAllByUser.mockResolvedValue([conv]);

      const result = await controller.getConversations(mockUser);

      expect(result.conversations[0].isGenerating).toBe(false);
      expect(result.conversations[0].awaitingClarification).toBe(false);
    });
  });

  describe('getConversation', () => {
    it('includes isGenerating and awaitingClarification on the detail response', async () => {
      const conv = baseConversation();
      conversationService.findByIdForUser.mockResolvedValue(conv);
      pipelineStatus.markExecuting('conv-1');

      const result = await controller.getConversation(mockUser, 'conv-1');

      expect(result.conversation.isGenerating).toBe(true);
      expect(result.conversation.awaitingClarification).toBe(false);
    });

    it('throws NotFoundException when the conversation does not belong to the user', async () => {
      conversationService.findByIdForUser.mockResolvedValue(null);

      await expect(controller.getConversation(mockUser, 'conv-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getConversationMessages', () => {
    it('includes metadata (generatedCode + validation) on a message that carries it', async () => {
      const generatedCode = { mainFile: 'console.log(1)', supportingFiles: {} };
      const conv = baseConversation({
        messages: [
          { role: 'user', content: 'Generate an MCP server', timestamp: new Date('2026-01-01T00:00:00Z') },
          {
            role: 'assistant',
            content: 'Done!',
            timestamp: new Date('2026-01-01T00:00:01Z'),
            metadata: {
              generatedCode,
              validation: {
                success: true,
                buildSuccess: true,
                toolsFound: 3,
                toolsPassedCount: 3,
                iterations: 1,
              },
            },
          },
        ],
      });
      conversationService.findByIdForUser.mockResolvedValue(conv);

      const result = await controller.getConversationMessages(mockUser, 'conv-1');

      expect(result.messages).toHaveLength(2);
      expect((result.messages[0] as any).metadata).toBeUndefined();
      expect((result.messages[1] as any).metadata).toEqual({
        generatedCode,
        validation: {
          success: true,
          buildSuccess: true,
          toolsFound: 3,
          toolsPassedCount: 3,
          iterations: 1,
        },
      });
    });

    it('omits the metadata key entirely for messages without it (no frontend-visible shape change)', async () => {
      const conv = baseConversation({
        messages: [
          { role: 'user', content: 'hi', timestamp: new Date('2026-01-01T00:00:00Z') },
          { role: 'assistant', content: 'hello', timestamp: new Date('2026-01-01T00:00:01Z') },
        ],
      });
      conversationService.findByIdForUser.mockResolvedValue(conv);

      const result = await controller.getConversationMessages(mockUser, 'conv-1');

      expect('metadata' in result.messages[0]).toBe(false);
      expect('metadata' in result.messages[1]).toBe(false);
    });

    it('throws NotFoundException when the conversation does not belong to the user', async () => {
      conversationService.findByIdForUser.mockResolvedValue(null);

      await expect(controller.getConversationMessages(mockUser, 'conv-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});

/**
 * HTTP-level coverage for ParseUUIDPipe on every :id route.
 *
 * The controller-level unit tests above call methods directly, which bypasses
 * Nest's param pipes entirely - they'd pass even if ParseUUIDPipe were removed.
 * These tests boot a real Nest HTTP pipeline (no global JWT guard registered
 * here, since none of this depends on auth) and hit the routes with a
 * non-UUID id to confirm garbage ids are rejected with 400 Bad Request
 * instead of reaching the service layer and causing a Postgres error / 500
 * with a dev stack trace.
 */
describe('ConversationController (HTTP - ParseUUIDPipe on :id routes)', () => {
  let app: INestApplication;

  const mockConversationService = {
    findAllByUser: jest.fn(),
    findByIdForUser: jest.fn(),
    create: jest.fn(),
    delete: jest.fn(),
    updateTitle: jest.fn(),
  };

  const mockDeploymentService = {
    getDeploymentsByConversation: jest.fn(),
    getLatestDeployment: jest.fn(),
  };

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ConversationController],
      providers: [
        { provide: ConversationService, useValue: mockConversationService },
        { provide: DeploymentService, useValue: mockDeploymentService },
        PipelineStatusService,
      ],
    }).compile();

    app = module.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const NOT_A_UUID = 'not-a-uuid';

  it.each([
    ['GET', '/api/conversations/:id', () => request(app.getHttpServer()).get(`/api/conversations/${NOT_A_UUID}`)],
    [
      'GET',
      '/api/conversations/:id/messages',
      () => request(app.getHttpServer()).get(`/api/conversations/${NOT_A_UUID}/messages`),
    ],
    [
      'GET',
      '/api/conversations/:id/deployments',
      () => request(app.getHttpServer()).get(`/api/conversations/${NOT_A_UUID}/deployments`),
    ],
    [
      'GET',
      '/api/conversations/:id/deployments/latest',
      () => request(app.getHttpServer()).get(`/api/conversations/${NOT_A_UUID}/deployments/latest`),
    ],
    [
      'DELETE',
      '/api/conversations/:id',
      () => request(app.getHttpServer()).delete(`/api/conversations/${NOT_A_UUID}`),
    ],
    [
      'PATCH',
      '/api/conversations/:id',
      () => request(app.getHttpServer()).patch(`/api/conversations/${NOT_A_UUID}`).send({ title: 'x' }),
    ],
  ])('returns 400 (not a 500/stack trace) for %s %s given a non-UUID id', async (_method, _route, makeRequest) => {
    const res = await makeRequest();

    expect(res.status).toBe(400);
    expect(mockConversationService.findByIdForUser).not.toHaveBeenCalled();
  });
});
