import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
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
});
