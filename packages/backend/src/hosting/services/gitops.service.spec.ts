import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { GitOpsService, GitOpsCommitResult } from './gitops.service';
import { GeneratedManifests } from './manifest-generator.service';

// Mock Octokit
jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    git: {
      getRef: jest.fn(),
      getCommit: jest.fn(),
      createBlob: jest.fn(),
      createTree: jest.fn(),
      createCommit: jest.fn(),
      updateRef: jest.fn(),
      getTree: jest.fn(),
    },
  })),
}));

describe('GitOpsService', () => {
  let service: GitOpsService;
  let mockOctokit: any;

  const mockManifests: GeneratedManifests = {
    deployment: 'apiVersion: apps/v1\nkind: Deployment\n...',
    service: 'apiVersion: v1\nkind: Service\n...',
    ingress: 'apiVersion: networking.k8s.io/v1\nkind: Ingress\n...',
  };

  const mockKustomization = 'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\n...';

  const mockConfigService = {
    get: jest.fn((key: string, defaultValue?: string) => {
      const config: Record<string, string> = {
        GITHUB_TOKEN: 'test-token',
        GITOPS_OWNER: '4eyedengineer',
        GITOPS_REPO: 'mcp-server-deployments',
        GITOPS_BRANCH: 'main',
      };
      return config[key] ?? defaultValue;
    }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GitOpsService,
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<GitOpsService>(GitOpsService);
    // Access the mocked Octokit instance
    mockOctokit = (service as any).octokit;
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('deployServer', () => {
    beforeEach(() => {
      // Setup successful mock responses
      mockOctokit.git.getRef.mockResolvedValue({
        data: { object: { sha: 'current-sha-123' } },
      });

      mockOctokit.git.getCommit.mockResolvedValue({
        data: { tree: { sha: 'tree-sha-123' } },
      });

      mockOctokit.git.createBlob.mockResolvedValue({
        data: { sha: 'blob-sha-123' },
      });

      mockOctokit.git.createTree.mockResolvedValue({
        data: { sha: 'new-tree-sha-123' },
      });

      mockOctokit.git.createCommit.mockResolvedValue({
        data: {
          sha: 'new-commit-sha-123',
          html_url: 'https://github.com/4eyedengineer/mcp-server-deployments/commit/new-commit-sha-123',
        },
      });

      mockOctokit.git.updateRef.mockResolvedValue({});
    });

    it('should commit manifests to GitOps repo', async () => {
      const result = await service.deployServer(
        'test-server',
        mockManifests,
        mockKustomization,
      );

      expect(result.success).toBe(true);
      expect(result.commitSha).toBe('new-commit-sha-123');
      expect(result.commitUrl).toBeDefined();
    });

    it('should get current branch reference', async () => {
      await service.deployServer('test-server', mockManifests, mockKustomization);

      expect(mockOctokit.git.getRef).toHaveBeenCalledWith({
        owner: '4eyedengineer',
        repo: 'mcp-server-deployments',
        ref: 'heads/main',
      });
    });

    it('should create blobs for all manifest files', async () => {
      await service.deployServer('test-server', mockManifests, mockKustomization);

      // Should create 4 blobs: deployment, service, ingress, kustomization
      expect(mockOctokit.git.createBlob).toHaveBeenCalledTimes(4);
    });

    it('should create tree with correct file paths', async () => {
      await service.deployServer('test-server', mockManifests, mockKustomization);

      expect(mockOctokit.git.createTree).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: '4eyedengineer',
          repo: 'mcp-server-deployments',
          base_tree: 'tree-sha-123',
          tree: expect.arrayContaining([
            expect.objectContaining({ path: 'servers/test-server/deployment.yaml' }),
            expect.objectContaining({ path: 'servers/test-server/service.yaml' }),
            expect.objectContaining({ path: 'servers/test-server/ingress.yaml' }),
            expect.objectContaining({ path: 'servers/test-server/kustomization.yaml' }),
          ]),
        }),
      );
    });

    it('should create commit with meaningful message', async () => {
      await service.deployServer('test-server', mockManifests, mockKustomization);

      expect(mockOctokit.git.createCommit).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Deploy MCP server: test-server',
        }),
      );
    });

    it('should update branch reference after commit', async () => {
      await service.deployServer('test-server', mockManifests, mockKustomization);

      expect(mockOctokit.git.updateRef).toHaveBeenCalledWith({
        owner: '4eyedengineer',
        repo: 'mcp-server-deployments',
        ref: 'heads/main',
        sha: 'new-commit-sha-123',
      });
    });

    it('should handle API errors gracefully', async () => {
      mockOctokit.git.getRef.mockRejectedValue(new Error('API rate limit exceeded'));

      const result = await service.deployServer(
        'test-server',
        mockManifests,
        mockKustomization,
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('API rate limit exceeded');
    });
  });

  describe('removeServer', () => {
    beforeEach(() => {
      mockOctokit.git.getRef.mockResolvedValue({
        data: { object: { sha: 'current-sha-123' } },
      });

      mockOctokit.git.getCommit.mockResolvedValue({
        data: { tree: { sha: 'tree-sha-123' } },
      });

      mockOctokit.git.getTree.mockResolvedValue({
        data: {
          tree: [
            { path: 'servers/test-server/deployment.yaml', sha: 'blob1', mode: '100644', type: 'blob' },
            { path: 'servers/test-server/service.yaml', sha: 'blob2', mode: '100644', type: 'blob' },
            { path: 'servers/other-server/deployment.yaml', sha: 'blob3', mode: '100644', type: 'blob' },
            { path: 'README.md', sha: 'blob4', mode: '100644', type: 'blob' },
          ],
        },
      });

      mockOctokit.git.createTree.mockResolvedValue({
        data: { sha: 'new-tree-sha-123' },
      });

      mockOctokit.git.createCommit.mockResolvedValue({
        data: {
          sha: 'remove-commit-sha-123',
          html_url: 'https://github.com/4eyedengineer/mcp-server-deployments/commit/remove-commit-sha-123',
        },
      });

      mockOctokit.git.updateRef.mockResolvedValue({});
    });

    it('should remove server directory from GitOps repo', async () => {
      const result = await service.removeServer('test-server');

      expect(result.success).toBe(true);
      expect(result.commitSha).toBe('remove-commit-sha-123');
    });

    it('should filter out files from server directory', async () => {
      await service.removeServer('test-server');

      expect(mockOctokit.git.createTree).toHaveBeenCalledWith(
        expect.objectContaining({
          tree: expect.not.arrayContaining([
            expect.objectContaining({ path: 'servers/test-server/deployment.yaml' }),
            expect.objectContaining({ path: 'servers/test-server/service.yaml' }),
          ]),
        }),
      );

      // Should preserve other files
      expect(mockOctokit.git.createTree).toHaveBeenCalledWith(
        expect.objectContaining({
          tree: expect.arrayContaining([
            expect.objectContaining({ path: 'servers/other-server/deployment.yaml' }),
            expect.objectContaining({ path: 'README.md' }),
          ]),
        }),
      );
    });

    it('should create commit with removal message', async () => {
      await service.removeServer('test-server');

      expect(mockOctokit.git.createCommit).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Remove MCP server: test-server',
        }),
      );
    });

    it('should handle API errors gracefully', async () => {
      mockOctokit.git.getRef.mockRejectedValue(new Error('Network error'));

      const result = await service.removeServer('test-server');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Network error');
    });
  });

  describe('updateServer', () => {
    beforeEach(() => {
      mockOctokit.git.getRef.mockResolvedValue({
        data: { object: { sha: 'current-sha-123' } },
      });

      mockOctokit.git.getCommit.mockResolvedValue({
        data: { tree: { sha: 'tree-sha-123' } },
      });

      mockOctokit.git.createBlob.mockResolvedValue({
        data: { sha: 'blob-sha-123' },
      });

      mockOctokit.git.createTree.mockResolvedValue({
        data: { sha: 'new-tree-sha-123' },
      });

      mockOctokit.git.createCommit.mockResolvedValue({
        data: {
          sha: 'update-commit-sha-123',
          html_url: 'https://github.com/4eyedengineer/mcp-server-deployments/commit/update-commit-sha-123',
        },
      });

      mockOctokit.git.updateRef.mockResolvedValue({});
    });

    it('should update server by overwriting manifests', async () => {
      const result = await service.updateServer(
        'test-server',
        mockManifests,
        mockKustomization,
      );

      expect(result.success).toBe(true);
      expect(result.commitSha).toBe('update-commit-sha-123');
    });

    it('should use same logic as deployServer', async () => {
      // updateServer is a wrapper around deployServer
      const deploySpy = jest.spyOn(service, 'deployServer');

      await service.updateServer('test-server', mockManifests, mockKustomization);

      expect(deploySpy).toHaveBeenCalledWith(
        'test-server',
        mockManifests,
        mockKustomization,
      );
    });
  });

  describe('configuration', () => {
    it('should use default values when config not provided', () => {
      const configWithDefaults = {
        get: jest.fn((key: string, defaultValue?: string) => {
          if (key === 'GITHUB_TOKEN') return 'test-token';
          return defaultValue;
        }),
      };

      // Create new module with defaults
      const testService = new GitOpsService(configWithDefaults as any);

      // Access private properties to verify defaults
      expect((testService as any).owner).toBe('4eyedengineer');
      expect((testService as any).repo).toBe('mcp-server-deployments');
      expect((testService as any).branch).toBe('main');
    });
  });
});
