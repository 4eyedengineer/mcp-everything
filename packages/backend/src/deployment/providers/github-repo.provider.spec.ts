/// <reference types="jest" />
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { GitHubRepoProvider } from './github-repo.provider';

describe('GitHubRepoProvider', () => {
  let provider: GitHubRepoProvider;
  let mockOctokit: any;

  const mockConfigService = {
    get: jest.fn().mockReturnValue('mock-github-token'),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GitHubRepoProvider,
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile();

    provider = module.get<GitHubRepoProvider>(GitHubRepoProvider);

    // Mock the Octokit instance
    mockOctokit = {
      rest: {
        users: {
          getAuthenticated: jest.fn().mockResolvedValue({
            data: { login: 'test-user' },
          }),
        },
        repos: {
          createForAuthenticatedUser: jest.fn().mockResolvedValue({
            data: {
              owner: { login: 'test-user' },
              name: 'test-repo',
              html_url: 'https://github.com/test-user/test-repo',
              clone_url: 'https://github.com/test-user/test-repo.git',
            },
          }),
          get: jest.fn().mockResolvedValue({
            data: { default_branch: 'main' },
          }),
        },
        git: {
          getRef: jest.fn().mockResolvedValue({
            data: { object: { sha: 'abc123' } },
          }),
          getCommit: jest.fn().mockResolvedValue({
            data: { tree: { sha: 'tree123' } },
          }),
          createBlob: jest.fn().mockResolvedValue({
            data: { sha: 'blob123' },
          }),
          createTree: jest.fn().mockResolvedValue({
            data: { sha: 'newtree123' },
          }),
          createCommit: jest.fn().mockResolvedValue({
            data: { sha: 'commit123' },
          }),
          updateRef: jest.fn().mockResolvedValue({}),
        },
      },
    };

    // Replace the octokit instance
    (provider as any).octokit = mockOctokit;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('createRepository', () => {
    it('should create a repository successfully', async () => {
      const result = await provider.createRepository('test-repo', 'Test description', true);

      expect(result).toEqual({
        owner: 'test-user',
        repo: 'test-repo',
        url: 'https://github.com/test-user/test-repo',
        cloneUrl: 'https://github.com/test-user/test-repo.git',
      });

      expect(mockOctokit.rest.repos.createForAuthenticatedUser).toHaveBeenCalledWith({
        name: 'test-repo',
        description: 'Test description',
        private: true,
        auto_init: true,
      });
    });

    it('should throw an error if repository creation fails', async () => {
      mockOctokit.rest.repos.createForAuthenticatedUser.mockRejectedValue(
        new Error('Repository already exists'),
      );

      await expect(provider.createRepository('test-repo', 'Test', false)).rejects.toThrow(
        'Repository already exists',
      );
    });
  });

  describe('pushFiles', () => {
    it('should push files to a repository successfully', async () => {
      const files = [
        { path: 'src/index.ts', content: 'console.log("hello");' },
        { path: 'package.json', content: '{"name": "test"}' },
      ];

      await provider.pushFiles('test-user', 'test-repo', files, 'Initial commit');

      expect(mockOctokit.rest.repos.get).toHaveBeenCalledWith({
        owner: 'test-user',
        repo: 'test-repo',
      });

      expect(mockOctokit.rest.git.createBlob).toHaveBeenCalledTimes(2);
      expect(mockOctokit.rest.git.createTree).toHaveBeenCalled();
      expect(mockOctokit.rest.git.createCommit).toHaveBeenCalled();
      expect(mockOctokit.rest.git.updateRef).toHaveBeenCalled();
    });
  });

  describe('repositoryExists', () => {
    it('should return true if repository exists', async () => {
      const result = await provider.repositoryExists('test-user', 'test-repo');
      expect(result).toBe(true);
    });

    it('should return false if repository does not exist', async () => {
      mockOctokit.rest.repos.get.mockRejectedValue(new Error('Not found'));

      const result = await provider.repositoryExists('test-user', 'nonexistent-repo');
      expect(result).toBe(false);
    });
  });

  describe('deploy', () => {
    it('should deploy files to a new repository successfully', async () => {
      // Mock repositoryExists to return false (no conflict)
      jest.spyOn(provider, 'repositoryExists').mockResolvedValue(false);

      const files = [{ path: 'src/index.ts', content: 'console.log("hello");' }];

      const result = await provider.deploy('test-server', files, 'Test MCP server', true);

      expect(result.success).toBe(true);
      expect(result.repositoryUrl).toBe('https://github.com/test-user/test-repo');
      expect(result.cloneUrl).toBe('https://github.com/test-user/test-repo.git');
      expect(result.codespaceUrl).toContain('codespaces/new');
    });

    it('should handle naming conflicts by appending timestamp', async () => {
      // Mock repositoryExists to return true first, then false
      jest
        .spyOn(provider, 'repositoryExists')
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      const files = [{ path: 'src/index.ts', content: 'console.log("hello");' }];

      const result = await provider.deploy('test-server', files, 'Test MCP server', false);

      expect(result.success).toBe(true);
      expect(provider.repositoryExists).toHaveBeenCalledTimes(2);
    });

    it('should fail after max naming conflict attempts', async () => {
      // Mock repositoryExists to always return true
      jest.spyOn(provider, 'repositoryExists').mockResolvedValue(true);

      const files = [{ path: 'src/index.ts', content: 'console.log("hello");' }];

      const result = await provider.deploy('test-server', files, 'Test MCP server', false);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to find unique repository name');
    });

    it('should return error result on deployment failure', async () => {
      jest.spyOn(provider, 'repositoryExists').mockResolvedValue(false);
      mockOctokit.rest.repos.createForAuthenticatedUser.mockRejectedValue(
        new Error('API error'),
      );

      const files = [{ path: 'src/index.ts', content: 'console.log("hello");' }];

      const result = await provider.deploy('test-server', files, 'Test MCP server', false);

      expect(result.success).toBe(false);
      expect(result.error).toBe('API error');
    });
  });

  describe('rate limit handling', () => {
    it('should retry on rate limit error (429)', async () => {
      const rateLimitError = new Error('Rate limit exceeded');
      (rateLimitError as any).status = 429;

      mockOctokit.rest.repos.createForAuthenticatedUser
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce({
          data: {
            owner: { login: 'test-user' },
            name: 'test-repo',
            html_url: 'https://github.com/test-user/test-repo',
            clone_url: 'https://github.com/test-user/test-repo.git',
          },
        });

      const result = await provider.createRepository('test-repo', 'Test', false);

      expect(result.owner).toBe('test-user');
      expect(mockOctokit.rest.repos.createForAuthenticatedUser).toHaveBeenCalledTimes(2);
    }, 10000);

    it('should retry on rate limit error (403)', async () => {
      const rateLimitError = new Error('Secondary rate limit');
      (rateLimitError as any).status = 403;

      mockOctokit.rest.repos.createForAuthenticatedUser
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce({
          data: {
            owner: { login: 'test-user' },
            name: 'test-repo',
            html_url: 'https://github.com/test-user/test-repo',
            clone_url: 'https://github.com/test-user/test-repo.git',
          },
        });

      const result = await provider.createRepository('test-repo', 'Test', false);

      expect(result.owner).toBe('test-user');
    }, 10000);

    it('should throw non-rate-limit errors immediately', async () => {
      const error = new Error('Not found');
      (error as any).status = 404;

      mockOctokit.rest.repos.createForAuthenticatedUser.mockRejectedValue(error);

      await expect(provider.createRepository('test-repo', 'Test', false)).rejects.toThrow(
        'Not found',
      );

      expect(mockOctokit.rest.repos.createForAuthenticatedUser).toHaveBeenCalledTimes(1);
    });
  });

  describe('sanitizeRepoName', () => {
    it('should sanitize repository names correctly', () => {
      const sanitize = (provider as any).sanitizeRepoName.bind(provider);

      expect(sanitize('My Cool Server')).toBe('my-cool-server');
      expect(sanitize('server@123!!')).toBe('server-123');
      expect(sanitize('--test--')).toBe('test');
      expect(sanitize('a'.repeat(150))).toHaveLength(100);
    });
  });
});
