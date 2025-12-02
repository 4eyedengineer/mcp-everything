/// <reference types="jest" />
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Octokit } from '@octokit/rest';
import { GitHubRepoProvider } from '../src/deployment/providers/github-repo.provider';
import { DeploymentFile } from '../src/deployment/types/deployment.types';

/**
 * Integration tests for GitHub deployment functionality.
 *
 * These tests create real GitHub repositories and should be run with care.
 * They require a valid GITHUB_TOKEN with repo scope.
 *
 * Run with: npm run test:e2e -- --testPathPattern=deployment
 *
 * IMPORTANT: These tests create real repositories that are cleaned up after each test.
 * If a test fails, you may need to manually delete test repositories.
 */
describe('Deployment Integration Tests (e2e)', () => {
  let app: INestApplication;
  let gitHubRepoProvider: GitHubRepoProvider;
  let octokit: Octokit;
  let owner: string;
  const createdRepos: string[] = [];

  const TEST_REPO_PREFIX = 'mcp-test-e2e-';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
        }),
      ],
      providers: [GitHubRepoProvider],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    gitHubRepoProvider = moduleFixture.get<GitHubRepoProvider>(GitHubRepoProvider);

    const configService = moduleFixture.get<ConfigService>(ConfigService);
    const githubToken = configService.get<string>('GITHUB_TOKEN');

    if (!githubToken) {
      throw new Error('GITHUB_TOKEN is required for integration tests');
    }

    octokit = new Octokit({ auth: githubToken });

    // Get authenticated user
    const { data: user } = await octokit.rest.users.getAuthenticated();
    owner = user.login;
  });

  afterAll(async () => {
    // Clean up all created repositories
    for (const repo of createdRepos) {
      try {
        await octokit.rest.repos.delete({ owner, repo });
        console.log(`Cleaned up test repository: ${owner}/${repo}`);
      } catch (error) {
        console.warn(`Failed to clean up repository ${owner}/${repo}: ${error.message}`);
      }
    }

    await app.close();
  });

  const generateTestRepoName = (): string => {
    return `${TEST_REPO_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  };

  const trackCreatedRepo = (repoName: string): void => {
    createdRepos.push(repoName);
  };

  describe('GitHubRepoProvider Integration', () => {
    it('should create a real GitHub repository', async () => {
      const repoName = generateTestRepoName();
      const description = 'Test repository for MCP Everything e2e tests';

      const result = await gitHubRepoProvider.createRepository(repoName, description, true);
      trackCreatedRepo(result.repo);

      expect(result.owner).toBe(owner);
      expect(result.repo).toBe(repoName);
      expect(result.url).toContain(`github.com/${owner}/${repoName}`);
      expect(result.cloneUrl).toContain('.git');

      // Verify repository exists
      const { data: repoData } = await octokit.rest.repos.get({
        owner,
        repo: repoName,
      });

      expect(repoData.name).toBe(repoName);
      expect(repoData.private).toBe(true);
      expect(repoData.description).toBe(description);
    }, 30000);

    it('should push files to a repository', async () => {
      const repoName = generateTestRepoName();

      // First create the repository
      const createResult = await gitHubRepoProvider.createRepository(
        repoName,
        'Test repo for file push',
        true,
      );
      trackCreatedRepo(createResult.repo);

      // Wait for repo to be ready
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Push test files
      const files: DeploymentFile[] = [
        {
          path: 'src/index.ts',
          content: `
import { Server } from '@modelcontextprotocol/sdk/server/index.js';

const server = new Server({
  name: 'test-mcp-server',
  version: '1.0.0',
});

export default server;
`.trim(),
        },
        {
          path: 'package.json',
          content: JSON.stringify(
            {
              name: 'test-mcp-server',
              version: '1.0.0',
              type: 'module',
              main: 'dist/index.js',
              scripts: {
                build: 'tsc',
                test: 'echo "No tests"',
              },
              dependencies: {
                '@modelcontextprotocol/sdk': '^1.0.0',
              },
              devDependencies: {
                typescript: '^5.0.0',
              },
            },
            null,
            2,
          ),
        },
        {
          path: 'tsconfig.json',
          content: JSON.stringify(
            {
              compilerOptions: {
                target: 'ES2022',
                module: 'NodeNext',
                moduleResolution: 'NodeNext',
                outDir: './dist',
                strict: true,
              },
              include: ['src/**/*'],
            },
            null,
            2,
          ),
        },
      ];

      await gitHubRepoProvider.pushFiles(owner, repoName, files, 'Add MCP server code');

      // Verify files exist in repository
      const { data: srcIndex } = await octokit.rest.repos.getContent({
        owner,
        repo: repoName,
        path: 'src/index.ts',
      });

      expect(srcIndex).toBeDefined();
      expect((srcIndex as any).name).toBe('index.ts');
    }, 60000);

    it('should deploy a complete MCP server', async () => {
      const serverName = generateTestRepoName();

      const files: DeploymentFile[] = [
        { path: 'src/index.ts', content: 'console.log("Hello MCP");' },
        { path: 'package.json', content: '{"name": "test", "version": "1.0.0"}' },
        { path: '.gitignore', content: 'node_modules/\ndist/\n.env\n' },
        {
          path: '.github/workflows/test.yml',
          content: `name: Test\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n`,
        },
      ];

      const result = await gitHubRepoProvider.deploy(
        serverName,
        files,
        'Complete MCP server deployment test',
        true,
      );

      expect(result.success).toBe(true);
      expect(result.repositoryUrl).toContain('github.com');
      expect(result.cloneUrl).toContain('.git');
      expect(result.codespaceUrl).toContain('codespaces');

      // Track for cleanup
      const repoName = result.repositoryUrl!.split('/').pop()!;
      trackCreatedRepo(repoName);

      // Verify all files exist
      const { data: files1 } = await octokit.rest.repos.getContent({
        owner,
        repo: repoName,
        path: '',
      });

      const fileNames = Array.isArray(files1) ? files1.map((f) => f.name) : [];
      expect(fileNames).toContain('src');
      expect(fileNames).toContain('package.json');
      expect(fileNames).toContain('.gitignore');
      expect(fileNames).toContain('.github');
    }, 60000);

    it('should handle naming conflicts', async () => {
      const baseName = generateTestRepoName();

      // Create first repository
      const result1 = await gitHubRepoProvider.createRepository(baseName, 'First repo', true);
      trackCreatedRepo(result1.repo);

      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Try to deploy with the same name - should get a different name due to conflict handling
      const files: DeploymentFile[] = [{ path: 'README.md', content: '# Test' }];

      const result2 = await gitHubRepoProvider.deploy(
        baseName,
        files,
        'Should get renamed due to conflict',
        true,
      );

      expect(result2.success).toBe(true);

      // The new repo should have a different name (with timestamp suffix)
      const newRepoName = result2.repositoryUrl!.split('/').pop()!;
      trackCreatedRepo(newRepoName);

      expect(newRepoName).not.toBe(baseName);
      expect(newRepoName).toContain(baseName);
    }, 60000);
  });

  describe('Error Handling', () => {
    it('should handle repository creation errors gracefully', async () => {
      // Try to create a repo with invalid name
      const result = await gitHubRepoProvider.deploy(
        '.',
        [{ path: 'README.md', content: '# Test' }],
        'Test',
        true,
      );

      // The sanitizer should handle this, resulting in an empty or minimal name
      // which should either fail or be handled gracefully
      // This test verifies error handling doesn't crash
      expect(typeof result.success).toBe('boolean');
    }, 30000);
  });
});
