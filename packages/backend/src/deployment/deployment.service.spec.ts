/// <reference types="jest" />
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
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
      find: jest.fn().mockResolvedValue([mockDeployment]),
      findOne: jest.fn().mockResolvedValue(mockDeployment),
      findOneBy: jest.fn().mockResolvedValue(mockDeployment),
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
    };

    mockGistProvider = {
      deploy: jest.fn().mockResolvedValue({
        success: true,
        gistUrl: 'https://gist.github.com/abc123',
        gistId: 'abc123',
      }),
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
});
