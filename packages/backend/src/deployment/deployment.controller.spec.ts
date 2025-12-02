import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { NotFoundException } from '@nestjs/common';
import { DeploymentController } from './deployment.controller';
import { DeploymentOrchestratorService } from './deployment.service';
import {
  DeployToGitHubDto,
  DeployToGistDto,
} from './dto/deploy-request.dto';
import { DeploymentResult, DeploymentStatusResponse } from './types/deployment.types';

describe('DeploymentController', () => {
  let controller: DeploymentController;
  let deploymentService: jest.Mocked<DeploymentOrchestratorService>;

  const mockDeploymentService = {
    deployToGitHub: jest.fn(),
    deployToGist: jest.fn(),
    deployToEnterprise: jest.fn(),
    getDeploymentStatus: jest.fn(),
    getLatestDeployment: jest.fn(),
    getDeploymentById: jest.fn(),
    listDeployments: jest.fn(),
    retryDeployment: jest.fn(),
    updateGistDeployment: jest.fn(),
    deleteGistDeployment: jest.fn(),
    deleteRepoDeployment: jest.fn(),
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
          provide: APP_GUARD,
          useClass: ThrottlerGuard,
        },
      ],
    }).compile();

    controller = module.get<DeploymentController>(DeploymentController);
    deploymentService = module.get(DeploymentOrchestratorService);

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

    it('should successfully deploy to GitHub', async () => {
      mockDeploymentService.deployToGitHub.mockResolvedValue(mockSuccessResult);

      const result = await controller.deployToGitHub(mockDto);

      expect(result).toEqual({
        success: true,
        deploymentId: 'deploy-123',
        type: 'repo',
        urls: mockSuccessResult.urls,
        error: undefined,
      });
      expect(mockDeploymentService.deployToGitHub).toHaveBeenCalledWith(
        mockDto.conversationId,
        mockDto.options,
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
      mockDeploymentService.deployToGitHub.mockResolvedValue(mockFailResult);

      const result = await controller.deployToGitHub(mockDto);

      expect(result.success).toBe(false);
      expect(result.error).toBe('No generated files found');
    });

    it('should handle service errors', async () => {
      mockDeploymentService.deployToGitHub.mockRejectedValue(
        new Error('GitHub API error'),
      );

      const result = await controller.deployToGitHub(mockDto);

      expect(result.success).toBe(false);
      expect(result.error).toBe('GitHub API error');
    });

    it('should accept optional serverName', async () => {
      const dtoWithServerName: DeployToGitHubDto = {
        conversationId: '123e4567-e89b-12d3-a456-426614174000',
        options: {
          serverName: 'my-custom-server',
        },
      };
      mockDeploymentService.deployToGitHub.mockResolvedValue(mockSuccessResult);

      await controller.deployToGitHub(dtoWithServerName);

      expect(mockDeploymentService.deployToGitHub).toHaveBeenCalledWith(
        dtoWithServerName.conversationId,
        { serverName: 'my-custom-server' },
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

    it('should successfully deploy to Gist', async () => {
      mockDeploymentService.deployToGist.mockResolvedValue(mockSuccessResult);

      const result = await controller.deployToGist(mockDto);

      expect(result.success).toBe(true);
      expect(result.type).toBe('gist');
      expect(result.urls?.gist).toBeDefined();
    });

    it('should handle Gist deployment failure', async () => {
      mockDeploymentService.deployToGist.mockRejectedValue(
        new Error('Gist creation failed'),
      );

      const result = await controller.deployToGist(mockDto);

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

    it('should return deployment status for a conversation', async () => {
      mockDeploymentService.getDeploymentStatus.mockResolvedValue(mockDeployments);

      const result = await controller.getDeploymentStatus(conversationId);

      expect(result.deployments).toHaveLength(2);
      expect(result.deployments[0].status).toBe('success');
      expect(result.deployments[1].status).toBe('failed');
    });

    it('should return empty array when no deployments exist', async () => {
      mockDeploymentService.getDeploymentStatus.mockResolvedValue([]);

      const result = await controller.getDeploymentStatus(conversationId);

      expect(result.deployments).toHaveLength(0);
    });
  });

  describe('getDeploymentById', () => {
    const deploymentId = 'deploy-123';

    it('should return deployment by ID', async () => {
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

      const result = await controller.getDeploymentById(deploymentId);

      expect(result.deploymentId).toBe(deploymentId);
      expect(result.status).toBe('success');
    });

    it('should throw NotFoundException when deployment not found', async () => {
      mockDeploymentService.getDeploymentById.mockResolvedValue(null);

      await expect(controller.getDeploymentById(deploymentId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('listDeployments', () => {
    it('should list deployments with pagination', async () => {
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

      const result = await controller.listDeployments({ limit: 20, offset: 0 });

      expect(result.deployments).toHaveLength(1);
      expect(result.total).toBe(1);
    });

    it('should filter by type', async () => {
      mockDeploymentService.listDeployments.mockResolvedValue({
        deployments: [],
        total: 0,
        limit: 20,
        offset: 0,
      });

      await controller.listDeployments({ type: 'gist' });

      expect(mockDeploymentService.listDeployments).toHaveBeenCalledWith({
        type: 'gist',
        status: undefined,
        limit: undefined,
        offset: undefined,
      });
    });

    it('should filter by status', async () => {
      mockDeploymentService.listDeployments.mockResolvedValue({
        deployments: [],
        total: 0,
        limit: 20,
        offset: 0,
      });

      await controller.listDeployments({ status: 'failed' });

      expect(mockDeploymentService.listDeployments).toHaveBeenCalledWith({
        type: undefined,
        status: 'failed',
        limit: undefined,
        offset: undefined,
      });
    });
  });

  describe('retryDeployment', () => {
    const conversationId = '123e4567-e89b-12d3-a456-426614174000';

    it('should retry failed deployment', async () => {
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

      const result = await controller.retryDeployment(conversationId);

      expect(result.success).toBe(true);
      expect(mockDeploymentService.retryDeployment).toHaveBeenCalledWith('deploy-123');
    });

    it('should return error when no deployment found', async () => {
      mockDeploymentService.getLatestDeployment.mockResolvedValue(null);

      const result = await controller.retryDeployment(conversationId);

      expect(result.success).toBe(false);
      expect(result.error).toBe('No deployment found for this conversation');
    });
  });

  describe('deleteGistDeployment', () => {
    it('should delete Gist deployment', async () => {
      mockDeploymentService.deleteGistDeployment.mockResolvedValue({
        success: true,
      });

      const result = await controller.deleteGistDeployment('deploy-123');

      expect(result.success).toBe(true);
    });

    it('should handle deletion errors', async () => {
      mockDeploymentService.deleteGistDeployment.mockRejectedValue(
        new Error('Gist not found'),
      );

      const result = await controller.deleteGistDeployment('deploy-123');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Gist not found');
    });
  });

  describe('deleteRepoDeployment', () => {
    it('should delete repository deployment', async () => {
      mockDeploymentService.deleteRepoDeployment.mockResolvedValue({
        success: true,
      });

      const result = await controller.deleteRepoDeployment('deploy-123');

      expect(result.success).toBe(true);
    });

    it('should handle deletion errors', async () => {
      mockDeploymentService.deleteRepoDeployment.mockRejectedValue(
        new Error('Repository not found'),
      );

      const result = await controller.deleteRepoDeployment('deploy-123');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Repository not found');
    });
  });
});
