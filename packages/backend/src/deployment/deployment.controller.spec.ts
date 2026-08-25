import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { NotFoundException, ForbiddenException } from '@nestjs/common';
import { DeploymentController } from './deployment.controller';
import { DeploymentOrchestratorService } from './deployment.service';
import { DeploymentRouterService } from './services/deployment-router.service';
import { DeploymentRetryService } from './services/retry.service';
import {
  DeployToGitHubDto,
  DeployToGistDto,
} from './dto/deploy-request.dto';
import { DeploymentResult, DeploymentStatusResponse } from './types/deployment.types';
import { User } from '../database/entities/user.entity';

describe('DeploymentController', () => {
  let controller: DeploymentController;
  let deploymentService: jest.Mocked<DeploymentOrchestratorService>;
  let routerService: jest.Mocked<DeploymentRouterService>;
  let retryService: jest.Mocked<DeploymentRetryService>;

  // Controller routes are scoped to the authenticated user (@CurrentUser())
  const mockUser = { id: 'user-123' } as User;

  const mockDeploymentService = {
    getDeploymentStatus: jest.fn(),
    getLatestDeployment: jest.fn(),
    getDeploymentById: jest.fn(),
    listDeployments: jest.fn(),
    retryDeployment: jest.fn(),
    updateGistDeployment: jest.fn(),
    deleteGistDeployment: jest.fn(),
    deleteRepoDeployment: jest.fn(),
    deployToEnterprise: jest.fn(),
  };

  const mockRouterService = {
    routeDeployment: jest.fn(),
  };

  const mockRetryService = {
    canRetry: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot([{
          ttl: 60000,
          limit: 10,
        }]),
      ],
      controllers: [DeploymentController],
      providers: [
        {
          provide: DeploymentOrchestratorService,
          useValue: mockDeploymentService,
        },
        {
          provide: DeploymentRouterService,
          useValue: mockRouterService,
        },
        {
          provide: DeploymentRetryService,
          useValue: mockRetryService,
        },
        {
          provide: APP_GUARD,
          useClass: ThrottlerGuard,
        },
      ],
    }).compile();

    controller = module.get<DeploymentController>(DeploymentController);
    deploymentService = module.get(DeploymentOrchestratorService);
    routerService = module.get(DeploymentRouterService);
    retryService = module.get(DeploymentRetryService);

    // Reset all mocks before each test
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('deployToGitHub', () => {
    const mockDto: DeployToGitHubDto = {
      conversationId: '123e4567-e89b-12d3-a456-426614174000',
      options: {
        isPrivate: true,
        description: 'Test deployment',
      },
    };

    const mockSuccessResult: DeploymentResult = {
      success: true,
      deploymentId: 'deploy-123',
      type: 'repo',
      urls: {
        repository: 'https://github.com/user/mcp-server-test',
        clone: 'https://github.com/user/mcp-server-test.git',
        codespace: 'https://github.com/codespaces/new?repo=123',
      },
    };

    it('should successfully deploy to GitHub via the router (tier-scoped)', async () => {
      mockRouterService.routeDeployment.mockResolvedValue(mockSuccessResult);

      const result = await controller.deployToGitHub(mockUser, mockDto);

      expect(result).toEqual({
        success: true,
        deploymentId: 'deploy-123',
        type: 'repo',
        urls: mockSuccessResult.urls,
        error: undefined,
        errorCause: undefined,
        errorCode: undefined,
        retryStrategy: undefined,
        retryAfterMs: undefined,
        suggestedNames: undefined,
        canRetry: undefined,
      });
      expect(mockRouterService.routeDeployment).toHaveBeenCalledWith(
        mockUser.id,
        mockDto.conversationId,
        { ...mockDto.options, deploymentType: 'repo' },
      );
    });

    it('should handle deployment failure', async () => {
      const mockFailResult: DeploymentResult = {
        success: false,
        deploymentId: 'deploy-123',
        type: 'repo',
        urls: {},
        error: 'No generated files found',
      };
      mockRouterService.routeDeployment.mockResolvedValue(mockFailResult);

      const result = await controller.deployToGitHub(mockUser, mockDto);

      expect(result.success).toBe(false);
      expect(result.error).toBe('No generated files found');
    });

    it('should handle service errors', async () => {
      mockRouterService.routeDeployment.mockRejectedValue(
        new Error('GitHub API error'),
      );

      const result = await controller.deployToGitHub(mockUser, mockDto);

      expect(result.success).toBe(false);
      expect(result.error).toBe('GitHub API error');
    });

    it('should return tier/limit details when router throws ForbiddenException', async () => {
      mockRouterService.routeDeployment.mockRejectedValue(
        new ForbiddenException({
          code: 'LIMIT_EXCEEDED',
          message: 'Monthly deployment limit reached',
          currentUsage: 5,
          limit: 5,
          currentTier: 'free',
          requiredTier: 'pro',
          upgradeUrl: '/account?upgrade=true',
        }),
      );

      const result = await controller.deployToGitHub(mockUser, mockDto);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Monthly deployment limit reached');
      expect(result.errorCode).toBe('LIMIT_EXCEEDED');
      expect(result.currentUsage).toBe(5);
      expect(result.limit).toBe(5);
      expect(result.currentTier).toBe('free');
      expect(result.requiredTier).toBe('pro');
      expect(result.upgradeUrl).toBe('/account?upgrade=true');
    });

    it('should include canRetry when the router result has an errorCode', async () => {
      mockRouterService.routeDeployment.mockResolvedValue({
        success: false,
        deploymentId: 'deploy-123',
        type: 'repo',
        urls: {},
        error: 'Repository name already exists',
        errorCode: 'REPOSITORY_NAME_CONFLICT',
      } as unknown as DeploymentResult);
      mockRetryService.canRetry.mockReturnValue(false);

      const result = await controller.deployToGitHub(mockUser, mockDto);

      expect(mockRetryService.canRetry).toHaveBeenCalledWith('REPOSITORY_NAME_CONFLICT');
      expect(result.canRetry).toBe(false);
    });

    it('should accept optional serverName', async () => {
      const dtoWithServerName: DeployToGitHubDto = {
        conversationId: '123e4567-e89b-12d3-a456-426614174000',
        options: {
          serverName: 'my-custom-server',
        },
      };
      mockRouterService.routeDeployment.mockResolvedValue(mockSuccessResult);

      await controller.deployToGitHub(mockUser, dtoWithServerName);

      expect(mockRouterService.routeDeployment).toHaveBeenCalledWith(
        mockUser.id,
        dtoWithServerName.conversationId,
        { serverName: 'my-custom-server', deploymentType: 'repo' },
      );
    });
  });

  describe('deployToGist', () => {
    const mockDto: DeployToGistDto = {
      conversationId: '123e4567-e89b-12d3-a456-426614174000',
    };

    const mockSuccessResult: DeploymentResult = {
      success: true,
      deploymentId: 'deploy-456',
      type: 'gist',
      urls: {
        gist: 'https://gist.github.com/user/abc123',
        gistRaw: 'https://gist.githubusercontent.com/user/abc123/raw/server.js',
      },
    };

    it('should successfully deploy to Gist via the router', async () => {
      mockRouterService.routeDeployment.mockResolvedValue(mockSuccessResult);

      const result = await controller.deployToGist(mockUser, mockDto);

      expect(result.success).toBe(true);
      expect(result.type).toBe('gist');
      expect(result.urls?.gist).toBeDefined();
      expect(mockRouterService.routeDeployment).toHaveBeenCalledWith(
        mockUser.id,
        mockDto.conversationId,
        { deploymentType: 'gist' },
      );
    });

    it('should handle Gist deployment failure', async () => {
      mockRouterService.routeDeployment.mockRejectedValue(
        new Error('Gist creation failed'),
      );

      const result = await controller.deployToGist(mockUser, mockDto);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Gist creation failed');
    });
  });

  describe('getDeploymentStatus', () => {
    const conversationId = '123e4567-e89b-12d3-a456-426614174000';

    const mockDeployments: DeploymentStatusResponse[] = [
      {
        deploymentId: 'deploy-1',
        conversationId,
        type: 'repo',
        status: 'success',
        urls: { repository: 'https://github.com/user/server1' },
        createdAt: new Date(),
        deployedAt: new Date(),
      },
      {
        deploymentId: 'deploy-2',
        conversationId,
        type: 'gist',
        status: 'failed',
        urls: {},
        errorMessage: 'Rate limit exceeded',
        createdAt: new Date(),
      },
    ];

    it('should return deployment status for a conversation, scoped to the user', async () => {
      mockDeploymentService.getDeploymentStatus.mockResolvedValue(mockDeployments);

      const result = await controller.getDeploymentStatus(mockUser, conversationId);

      expect(result.deployments).toHaveLength(2);
      expect(result.deployments[0].status).toBe('success');
      expect(result.deployments[1].status).toBe('failed');
      expect(mockDeploymentService.getDeploymentStatus).toHaveBeenCalledWith(
        conversationId,
        mockUser.id,
      );
    });

    it('should return empty array when no deployments exist', async () => {
      mockDeploymentService.getDeploymentStatus.mockResolvedValue([]);

      const result = await controller.getDeploymentStatus(mockUser, conversationId);

      expect(result.deployments).toHaveLength(0);
    });
  });

  describe('getDeploymentById', () => {
    const deploymentId = 'deploy-123';

    it('should return deployment by ID, scoped to the user', async () => {
      const mockDeployment: DeploymentStatusResponse = {
        deploymentId,
        conversationId: '123e4567-e89b-12d3-a456-426614174000',
        type: 'repo',
        status: 'success',
        urls: { repository: 'https://github.com/user/server' },
        createdAt: new Date(),
        deployedAt: new Date(),
      };
      mockDeploymentService.getDeploymentById.mockResolvedValue(mockDeployment);

      const result = await controller.getDeploymentById(mockUser, deploymentId);

      expect(result.deploymentId).toBe(deploymentId);
      expect(result.status).toBe('success');
      expect(mockDeploymentService.getDeploymentById).toHaveBeenCalledWith(
        deploymentId,
        mockUser.id,
      );
    });

    it('should throw NotFoundException when deployment not found (or not owned by user)', async () => {
      mockDeploymentService.getDeploymentById.mockResolvedValue(null);

      await expect(controller.getDeploymentById(mockUser, deploymentId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('listDeployments', () => {
    it('should list deployments with pagination, scoped to the user', async () => {
      const mockResult = {
        deployments: [
          {
            deploymentId: 'deploy-1',
            conversationId: '123',
            type: 'repo' as const,
            status: 'success' as const,
            urls: {},
            createdAt: new Date(),
          },
        ],
        total: 1,
        limit: 20,
        offset: 0,
      };
      mockDeploymentService.listDeployments.mockResolvedValue(mockResult);

      const result = await controller.listDeployments(mockUser, { limit: 20, offset: 0 });

      expect(result.deployments).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(mockDeploymentService.listDeployments).toHaveBeenCalledWith(
        expect.objectContaining({ userId: mockUser.id }),
      );
    });

    it('should never list another user\'s deployments', async () => {
      mockDeploymentService.listDeployments.mockResolvedValue({
        deployments: [],
        total: 0,
        limit: 20,
        offset: 0,
      });

      await controller.listDeployments(mockUser, {});

      expect(mockDeploymentService.listDeployments).toHaveBeenCalledWith({
        type: undefined,
        status: undefined,
        limit: undefined,
        offset: undefined,
        userId: mockUser.id,
      });
    });

    it('should filter by type', async () => {
      mockDeploymentService.listDeployments.mockResolvedValue({
        deployments: [],
        total: 0,
        limit: 20,
        offset: 0,
      });

      await controller.listDeployments(mockUser, { type: 'gist' });

      expect(mockDeploymentService.listDeployments).toHaveBeenCalledWith({
        type: 'gist',
        status: undefined,
        limit: undefined,
        offset: undefined,
        userId: mockUser.id,
      });
    });

    it('should filter by status', async () => {
      mockDeploymentService.listDeployments.mockResolvedValue({
        deployments: [],
        total: 0,
        limit: 20,
        offset: 0,
      });

      await controller.listDeployments(mockUser, { status: 'failed' });

      expect(mockDeploymentService.listDeployments).toHaveBeenCalledWith({
        type: undefined,
        status: 'failed',
        limit: undefined,
        offset: undefined,
        userId: mockUser.id,
      });
    });
  });

  describe('retryDeploymentByConversation', () => {
    const conversationId = '123e4567-e89b-12d3-a456-426614174000';

    it('should retry the latest failed deployment for the conversation (owned by user)', async () => {
      const mockDeployment = {
        id: 'deploy-123',
        conversationId,
        deploymentType: 'repo',
        status: 'failed',
      };
      mockDeploymentService.getLatestDeployment.mockResolvedValue(mockDeployment);
      mockDeploymentService.retryDeployment.mockResolvedValue({
        success: true,
        deploymentId: 'deploy-124',
        type: 'repo',
        urls: { repository: 'https://github.com/user/server' },
      });

      const result = await controller.retryDeploymentByConversation(mockUser, conversationId);

      expect(result.success).toBe(true);
      expect(mockDeploymentService.getLatestDeployment).toHaveBeenCalledWith(
        conversationId,
        mockUser.id,
      );
      expect(mockDeploymentService.retryDeployment).toHaveBeenCalledWith(
        'deploy-123',
        undefined,
        undefined,
        mockUser.id,
      );
    });

    it('should pass through newServerName / forceRetry from the request body', async () => {
      mockDeploymentService.getLatestDeployment.mockResolvedValue({
        id: 'deploy-123',
        conversationId,
        deploymentType: 'repo',
        status: 'failed',
      });
      mockDeploymentService.retryDeployment.mockResolvedValue({
        success: true,
        deploymentId: 'deploy-124',
        type: 'repo',
        urls: {},
      });

      await controller.retryDeploymentByConversation(mockUser, conversationId, {
        deploymentId: 'deploy-123',
        newServerName: 'renamed-server',
        forceRetry: true,
      });

      expect(mockDeploymentService.retryDeployment).toHaveBeenCalledWith(
        'deploy-123',
        'renamed-server',
        true,
        mockUser.id,
      );
    });

    it('should return error when no deployment found for the user', async () => {
      mockDeploymentService.getLatestDeployment.mockResolvedValue(null);

      const result = await controller.retryDeploymentByConversation(mockUser, conversationId);

      expect(result.success).toBe(false);
      expect(result.error).toBe('No deployment found for this conversation');
      expect(mockDeploymentService.retryDeployment).not.toHaveBeenCalled();
    });
  });

  describe('retryDeploymentById', () => {
    it('should retry a deployment by its ID, scoped to the user', async () => {
      mockDeploymentService.retryDeployment.mockResolvedValue({
        success: true,
        deploymentId: 'deploy-124',
        type: 'gist',
        urls: { gist: 'https://gist.github.com/user/abc' },
      });

      const result = await controller.retryDeploymentById(mockUser, 'deploy-123');

      expect(result.success).toBe(true);
      expect(mockDeploymentService.retryDeployment).toHaveBeenCalledWith(
        'deploy-123',
        undefined,
        undefined,
        mockUser.id,
      );
    });

    it('should return an error response when the service throws', async () => {
      mockDeploymentService.retryDeployment.mockRejectedValue(
        new NotFoundException('Deployment not found: deploy-123'),
      );

      const result = await controller.retryDeploymentById(mockUser, 'deploy-123');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Deployment not found');
    });
  });

  describe('deleteGistDeployment', () => {
    it('should delete Gist deployment scoped to the user', async () => {
      mockDeploymentService.deleteGistDeployment.mockResolvedValue({
        success: true,
      });

      const result = await controller.deleteGistDeployment(mockUser, 'deploy-123');

      expect(result.success).toBe(true);
      expect(mockDeploymentService.deleteGistDeployment).toHaveBeenCalledWith(
        'deploy-123',
        mockUser.id,
      );
    });

    it('should handle deletion errors', async () => {
      mockDeploymentService.deleteGistDeployment.mockRejectedValue(
        new Error('Gist not found'),
      );

      const result = await controller.deleteGistDeployment(mockUser, 'deploy-123');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Gist not found');
    });
  });

  describe('deleteRepoDeployment', () => {
    it('should delete repository deployment scoped to the user', async () => {
      mockDeploymentService.deleteRepoDeployment.mockResolvedValue({
        success: true,
      });

      const result = await controller.deleteRepoDeployment(mockUser, 'deploy-123');

      expect(result.success).toBe(true);
      expect(mockDeploymentService.deleteRepoDeployment).toHaveBeenCalledWith(
        'deploy-123',
        mockUser.id,
      );
    });

    it('should handle deletion errors', async () => {
      mockDeploymentService.deleteRepoDeployment.mockRejectedValue(
        new Error('Repository not found'),
      );

      const result = await controller.deleteRepoDeployment(mockUser, 'deploy-123');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Repository not found');
    });
  });
});
