/// <reference types="jest" />
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException, NotImplementedException } from '@nestjs/common';
import { DeploymentOrchestratorService } from './deployment.service';
import { Deployment } from '../database/entities/deployment.entity';
import { Conversation } from '../database/entities/conversation.entity';
import { GitHubRepoProvider } from './providers/github-repo.provider';
import { GistProvider } from './providers/gist.provider';
import { DevContainerProvider } from './providers/devcontainer.provider';
import { GitignoreProvider } from './providers/gitignore.provider';
import { CIWorkflowProvider } from './providers/ci-workflow.provider';

describe('DeploymentOrchestratorService', () => {
  let service: DeploymentOrchestratorService;
  let mockDeploymentRepository: any;
  let mockConversationRepository: any;
  let mockGitHubRepoProvider: any;
  let mockGistProvider: any;
  let mockDevContainerProvider: any;
  let mockGitignoreProvider: any;
  let mockCIWorkflowProvider: any;

  const mockConversation = {
    id: 'conv-123',
    state: { serverName: 'test-mcp-server' },
  };

  const mockDeployment = {
    id: 'deploy-123',
    conversationId: 'conv-123',
    deploymentType: 'repo',
    status: 'pending',
    metadata: {},
  };

  beforeEach(async () => {
    mockDeploymentRepository = {
      create: jest.fn().mockReturnValue(mockDeployment),
      save: jest.fn().mockResolvedValue(mockDeployment),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
      find: jest.fn().mockResolvedValue([mockDeployment]),
      findOne: jest.fn().mockResolvedValue(mockDeployment),
      findOneBy: jest.fn().mockResolvedValue(mockDeployment),
      count: jest.fn().mockResolvedValue(1),
    };

    mockConversationRepository = {
      findOneBy: jest.fn().mockResolvedValue(mockConversation),
    };

    mockGitHubRepoProvider = {
      deploy: jest.fn().mockResolvedValue({
        success: true,
        repositoryUrl: 'https://github.com/test-user/test-repo',
        cloneUrl: 'https://github.com/test-user/test-repo.git',
        codespaceUrl: 'https://github.com/codespaces/new?repo=test-user/test-repo',
      }),
      deleteRepository: jest.fn().mockResolvedValue(true),
      parseRepoUrl: jest.fn().mockReturnValue({ owner: 'test-user', repo: 'test-repo' }),
    };

    mockGistProvider = {
      deploy: jest.fn().mockResolvedValue({
        success: true,
        gistUrl: 'https://gist.github.com/abc123',
        gistId: 'abc123',
      }),
      deploySingleFile: jest.fn().mockResolvedValue({
        success: true,
        gistUrl: 'https://gist.github.com/abc123',
        gistId: 'abc123',
        rawUrl: 'https://gist.githubusercontent.com/abc123/raw',
      }),
      updateGist: jest.fn().mockResolvedValue({
        success: true,
        gistUrl: 'https://gist.github.com/abc123',
        gistId: 'abc123',
        rawUrl: 'https://gist.githubusercontent.com/abc123/raw',
      }),
      deleteGist: jest.fn().mockResolvedValue(true),
    };

    mockDevContainerProvider = {
      generateDevContainerFiles: jest.fn().mockReturnValue([
        { path: '.devcontainer/devcontainer.json', content: '{}' },
      ]),
    };

    mockGitignoreProvider = {
      generateGitignoreFiles: jest.fn().mockReturnValue([
        { path: '.gitignore', content: 'node_modules/' },
      ]),
    };

    mockCIWorkflowProvider = {
      generateCIWorkflowFiles: jest.fn().mockReturnValue([
        { path: '.github/workflows/test.yml', content: 'name: Test' },
      ]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeploymentOrchestratorService,
        {
          provide: getRepositoryToken(Deployment),
          useValue: mockDeploymentRepository,
        },
        {
          provide: getRepositoryToken(Conversation),
          useValue: mockConversationRepository,
        },
        {
          provide: GitHubRepoProvider,
          useValue: mockGitHubRepoProvider,
        },
        {
          provide: GistProvider,
          useValue: mockGistProvider,
        },
        {
          provide: DevContainerProvider,
          useValue: mockDevContainerProvider,
        },
        {
          provide: GitignoreProvider,
          useValue: mockGitignoreProvider,
        },
        {
          provide: CIWorkflowProvider,
          useValue: mockCIWorkflowProvider,
        },
      ],
    }).compile();

    service = module.get<DeploymentOrchestratorService>(DeploymentOrchestratorService);

    // Mock the file reading method
    (service as any).getGeneratedFiles = jest.fn().mockResolvedValue([
      { path: 'src/index.ts', content: 'console.log("hello");' },
      { path: 'package.json', content: '{"name": "test"}' },
    ]);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('deployToGitHub', () => {
    it('should deploy to GitHub successfully', async () => {
      const result = await service.deployToGitHub('conv-123', {});

      expect(result.success).toBe(true);
      expect(result.type).toBe('repo');
      expect(result.urls.repository).toBe('https://github.com/test-user/test-repo');
      expect(result.urls.clone).toBe('https://github.com/test-user/test-repo.git');
      expect(result.urls.codespace).toContain('codespaces');
    });

    it('should throw NotFoundException if conversation does not exist', async () => {
      mockConversationRepository.findOneBy.mockResolvedValue(null);

      await expect(service.deployToGitHub('nonexistent', {})).rejects.toThrow(NotFoundException);
    });

    it('should return error if no generated files found', async () => {
      (service as any).getGeneratedFiles.mockResolvedValue([]);

      const result = await service.deployToGitHub('conv-123', {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('No generated files');
    });

    it('should add .gitignore files automatically', async () => {
      await service.deployToGitHub('conv-123', {});

      expect(mockGitignoreProvider.generateGitignoreFiles).toHaveBeenCalled();
    });

    it('should add CI workflow files automatically', async () => {
      await service.deployToGitHub('conv-123', {});

      expect(mockCIWorkflowProvider.generateCIWorkflowFiles).toHaveBeenCalledWith(
        'test-mcp-server',
      );
    });

    it('should add devcontainer files when requested', async () => {
      await service.deployToGitHub('conv-123', { includeDevContainer: true });

      expect(mockDevContainerProvider.generateDevContainerFiles).toHaveBeenCalled();
    });

    it('should not add devcontainer files by default', async () => {
      await service.deployToGitHub('conv-123', {});

      expect(mockDevContainerProvider.generateDevContainerFiles).not.toHaveBeenCalled();
    });

    it('should default to private repositories', async () => {
      await service.deployToGitHub('conv-123', {});

      expect(mockGitHubRepoProvider.deploy).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.any(String),
        true, // isPrivate should be true by default
      );
    });

    it('should respect explicit isPrivate option', async () => {
      await service.deployToGitHub('conv-123', { isPrivate: false });

      expect(mockGitHubRepoProvider.deploy).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.any(String),
        false,
      );
    });

    it('should use custom description when provided', async () => {
      await service.deployToGitHub('conv-123', { description: 'Custom description' });

      expect(mockGitHubRepoProvider.deploy).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        'Custom description',
        expect.any(Boolean),
      );
    });

    it('should update deployment record on success', async () => {
      await service.deployToGitHub('conv-123', {});

      expect(mockDeploymentRepository.update).toHaveBeenCalledWith(
        'deploy-123',
        expect.objectContaining({
          status: 'success',
          repositoryUrl: 'https://github.com/test-user/test-repo',
        }),
      );
    });

    it('should update deployment record on failure', async () => {
      mockGitHubRepoProvider.deploy.mockResolvedValue({
        success: false,
        error: 'Deployment failed',
      });

      await service.deployToGitHub('conv-123', {});

      expect(mockDeploymentRepository.update).toHaveBeenCalledWith(
        'deploy-123',
        expect.objectContaining({
          status: 'failed',
          errorMessage: 'Deployment failed',
        }),
      );
    });
  });

  describe('deployToGist', () => {
    it('should deploy to Gist successfully', async () => {
      const result = await service.deployToGist('conv-123', {});

      expect(result.success).toBe(true);
      expect(result.type).toBe('gist');
      expect(result.urls.gist).toBe('https://gist.github.com/abc123');
    });

    it('should throw NotFoundException if conversation does not exist', async () => {
      mockConversationRepository.findOneBy.mockResolvedValue(null);

      await expect(service.deployToGist('nonexistent', {})).rejects.toThrow(NotFoundException);
    });
  });

  describe('getDeploymentStatus', () => {
    it('should return deployment status for a conversation', async () => {
      const result = await service.getDeploymentStatus('conv-123');

      expect(result).toHaveLength(1);
      expect(result[0].conversationId).toBe('conv-123');
      expect(mockDeploymentRepository.find).toHaveBeenCalledWith({
        where: { conversationId: 'conv-123' },
        order: { createdAt: 'DESC' },
      });
    });
  });

  describe('retryDeployment', () => {
    it('should retry a failed repo deployment', async () => {
      mockDeploymentRepository.findOneBy.mockResolvedValue({
        ...mockDeployment,
        status: 'failed',
        deploymentType: 'repo',
        metadata: { options: {} },
      });

      const result = await service.retryDeployment('deploy-123');

      expect(result.success).toBe(true);
      expect(result.type).toBe('repo');
    });

    it('should retry a failed gist deployment', async () => {
      mockDeploymentRepository.findOneBy.mockResolvedValue({
        ...mockDeployment,
        status: 'failed',
        deploymentType: 'gist',
        metadata: { options: {} },
      });

      const result = await service.retryDeployment('deploy-123');

      expect(result.success).toBe(true);
      expect(result.type).toBe('gist');
    });

    it('should throw NotFoundException if deployment does not exist', async () => {
      mockDeploymentRepository.findOneBy.mockResolvedValue(null);

      await expect(service.retryDeployment('nonexistent')).rejects.toThrow(NotFoundException);
    });

    it('should throw error if deployment is not failed', async () => {
      mockDeploymentRepository.findOneBy.mockResolvedValue({
        ...mockDeployment,
        status: 'success',
      });

      await expect(service.retryDeployment('deploy-123')).rejects.toThrow(
        'Can only retry failed deployments',
      );
    });
  });

  describe('getLatestDeployment', () => {
    it('should return the latest deployment for a conversation', async () => {
      const result = await service.getLatestDeployment('conv-123');

      expect(result).toEqual(mockDeployment);
      expect(mockDeploymentRepository.findOne).toHaveBeenCalledWith({
        where: { conversationId: 'conv-123' },
        order: { createdAt: 'DESC' },
      });
    });

    it('should return null if no deployments exist', async () => {
      mockDeploymentRepository.findOne.mockResolvedValue(null);

      const result = await service.getLatestDeployment('conv-123');

      expect(result).toBeNull();
    });
  });

  describe('getDeploymentById', () => {
    it('should return deployment by ID', async () => {
      mockDeploymentRepository.findOneBy.mockResolvedValue({
        id: 'deploy-123',
        conversationId: 'conv-123',
        deploymentType: 'repo',
        status: 'success',
        repositoryUrl: 'https://github.com/test-user/test-repo',
        metadata: {},
        createdAt: new Date(),
      });

      const result = await service.getDeploymentById('deploy-123');

      expect(result).not.toBeNull();
      expect(result?.deploymentId).toBe('deploy-123');
      expect(result?.type).toBe('repo');
    });

    it('should return null if deployment does not exist', async () => {
      mockDeploymentRepository.findOneBy.mockResolvedValue(null);

      const result = await service.getDeploymentById('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('listDeployments', () => {
    it('should list all deployments with default pagination', async () => {
      mockDeploymentRepository.find.mockResolvedValue([
        {
          id: 'deploy-123',
          conversationId: 'conv-123',
          deploymentType: 'repo',
          status: 'success',
          metadata: {},
          createdAt: new Date(),
        },
      ]);

      const result = await service.listDeployments({});

      expect(result.deployments).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.limit).toBe(20);
      expect(result.offset).toBe(0);
    });

    it('should filter by deployment type', async () => {
      await service.listDeployments({ type: 'gist' });

      expect(mockDeploymentRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { deploymentType: 'gist' },
        }),
      );
    });

    it('should filter by status', async () => {
      await service.listDeployments({ status: 'failed' });

      expect(mockDeploymentRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: 'failed' },
        }),
      );
    });

    it('should respect pagination parameters', async () => {
      await service.listDeployments({ limit: 10, offset: 5 });

      expect(mockDeploymentRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 10,
          skip: 5,
        }),
      );
    });

    it('should cap limit at 100', async () => {
      await service.listDeployments({ limit: 500 });

      expect(mockDeploymentRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 100,
        }),
      );
    });
  });

  describe('updateGistDeployment', () => {
    it('should update a Gist deployment', async () => {
      mockDeploymentRepository.findOneBy.mockResolvedValue({
        id: 'deploy-123',
        conversationId: 'conv-123',
        deploymentType: 'gist',
        status: 'success',
        metadata: { gistId: 'abc123' },
      });

      const result = await service.updateGistDeployment('deploy-123', 'New description');

      expect(result.success).toBe(true);
      expect(mockGistProvider.updateGist).toHaveBeenCalledWith(
        'abc123',
        expect.any(Array),
        'New description',
      );
    });

    it('should throw NotFoundException if deployment does not exist', async () => {
      mockDeploymentRepository.findOneBy.mockResolvedValue(null);

      await expect(service.updateGistDeployment('nonexistent')).rejects.toThrow(NotFoundException);
    });

    it('should throw error if not a Gist deployment', async () => {
      mockDeploymentRepository.findOneBy.mockResolvedValue({
        ...mockDeployment,
        deploymentType: 'repo',
      });

      await expect(service.updateGistDeployment('deploy-123')).rejects.toThrow(
        'Can only update Gist deployments',
      );
    });

    it('should throw error if gistId is missing', async () => {
      mockDeploymentRepository.findOneBy.mockResolvedValue({
        id: 'deploy-123',
        conversationId: 'conv-123',
        deploymentType: 'gist',
        metadata: {},
      });

      await expect(service.updateGistDeployment('deploy-123')).rejects.toThrow(
        'Gist ID not found',
      );
    });
  });

  describe('deleteGistDeployment', () => {
    it('should delete a Gist deployment', async () => {
      mockDeploymentRepository.findOneBy.mockResolvedValue({
        id: 'deploy-123',
        conversationId: 'conv-123',
        deploymentType: 'gist',
        metadata: { gistId: 'abc123' },
      });

      const result = await service.deleteGistDeployment('deploy-123');

      expect(result.success).toBe(true);
      expect(mockGistProvider.deleteGist).toHaveBeenCalledWith('abc123');
      expect(mockDeploymentRepository.delete).toHaveBeenCalledWith('deploy-123');
    });

    it('should throw NotFoundException if deployment does not exist', async () => {
      mockDeploymentRepository.findOneBy.mockResolvedValue(null);

      await expect(service.deleteGistDeployment('nonexistent')).rejects.toThrow(NotFoundException);
    });

    it('should throw error if not a Gist deployment', async () => {
      mockDeploymentRepository.findOneBy.mockResolvedValue({
        ...mockDeployment,
        deploymentType: 'repo',
      });

      await expect(service.deleteGistDeployment('deploy-123')).rejects.toThrow(
        'Can only delete Gist deployments',
      );
    });

    it('should delete record even if no gistId', async () => {
      mockDeploymentRepository.findOneBy.mockResolvedValue({
        id: 'deploy-123',
        conversationId: 'conv-123',
        deploymentType: 'gist',
        metadata: {},
      });

      const result = await service.deleteGistDeployment('deploy-123');

      expect(result.success).toBe(true);
      expect(mockGistProvider.deleteGist).not.toHaveBeenCalled();
      expect(mockDeploymentRepository.delete).toHaveBeenCalledWith('deploy-123');
    });
  });

  describe('deleteRepoDeployment', () => {
    it('should delete a repository deployment', async () => {
      mockDeploymentRepository.findOneBy.mockResolvedValue({
        id: 'deploy-123',
        conversationId: 'conv-123',
        deploymentType: 'repo',
        repositoryUrl: 'https://github.com/test-user/test-repo',
      });

      const result = await service.deleteRepoDeployment('deploy-123');

      expect(result.success).toBe(true);
      expect(mockGitHubRepoProvider.parseRepoUrl).toHaveBeenCalledWith(
        'https://github.com/test-user/test-repo',
      );
      expect(mockGitHubRepoProvider.deleteRepository).toHaveBeenCalledWith('test-user', 'test-repo');
      expect(mockDeploymentRepository.delete).toHaveBeenCalledWith('deploy-123');
    });

    it('should throw NotFoundException if deployment does not exist', async () => {
      mockDeploymentRepository.findOneBy.mockResolvedValue(null);

      await expect(service.deleteRepoDeployment('nonexistent')).rejects.toThrow(NotFoundException);
    });

    it('should throw error if not a repo deployment', async () => {
      mockDeploymentRepository.findOneBy.mockResolvedValue({
        ...mockDeployment,
        deploymentType: 'gist',
      });

      await expect(service.deleteRepoDeployment('deploy-123')).rejects.toThrow(
        'Can only delete repository deployments',
      );
    });

    it('should delete record even if no repositoryUrl', async () => {
      mockDeploymentRepository.findOneBy.mockResolvedValue({
        id: 'deploy-123',
        conversationId: 'conv-123',
        deploymentType: 'repo',
        repositoryUrl: null,
      });

      const result = await service.deleteRepoDeployment('deploy-123');

      expect(result.success).toBe(true);
      expect(mockGitHubRepoProvider.deleteRepository).not.toHaveBeenCalled();
      expect(mockDeploymentRepository.delete).toHaveBeenCalledWith('deploy-123');
    });
  });

  describe('deployToEnterprise', () => {
    it('should throw NotImplementedException', async () => {
      await expect(service.deployToEnterprise('conv-123', {})).rejects.toThrow(
        NotImplementedException,
      );
    });

    it('should include helpful message in error', async () => {
      try {
        await service.deployToEnterprise('conv-123', {});
      } catch (error) {
        expect(error.message).toContain('Enterprise deployment is not yet available');
        expect(error.message).toContain('custom domains');
      }
    });
  });
});
