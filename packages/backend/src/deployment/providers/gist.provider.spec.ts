/// <reference types="jest" />
import { Test, TestingModule } from '@nestjs/testing';
import { Octokit } from '@octokit/rest';
import { GistProvider } from './gist.provider';
import { DeploymentFile } from '../types/deployment.types';

// Mock @octokit/rest so we control gists.create/update/delete/get behavior
// per-test without hitting the network, and can assert exactly which token
// each client was built with. Follows the same convention as
// github/github.service.spec.ts.
const gistsCreate = jest.fn();
const gistsUpdate = jest.fn();
const gistsGet = jest.fn();
const gistsDelete = jest.fn();

jest.mock('@octokit/rest', () => {
  return {
    Octokit: jest.fn().mockImplementation((options: { auth?: string }) => ({
      __auth: options?.auth,
      rest: {
        gists: {
          create: (...args: unknown[]) => gistsCreate(...args),
          update: (...args: unknown[]) => gistsUpdate(...args),
          get: (...args: unknown[]) => gistsGet(...args),
          delete: (...args: unknown[]) => gistsDelete(...args),
        },
      },
    })),
  };
});

describe('GistProvider', () => {
  let provider: GistProvider;

  const files: DeploymentFile[] = [
    { path: 'src/index.ts', content: 'console.log("hello");' },
    { path: 'package.json', content: '{"name": "test-mcp-server"}' },
  ];

  const buildGistResponse = (overrides: Partial<Record<string, unknown>> = {}) => ({
    data: {
      id: 'abc123',
      html_url: 'https://gist.github.com/octocat/abc123',
      files: {
        'test-mcp-server.ts': {
          raw_url: 'https://gist.githubusercontent.com/octocat/abc123/raw/test-mcp-server.ts',
        },
      },
      ...overrides,
    },
  });

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [GistProvider],
    }).compile();

    provider = module.get<GistProvider>(GistProvider);
  });

  describe('createSingleFileGist / deploySingleFile', () => {
    it("builds the Octokit client from the passed user token, not any server-wide credential", async () => {
      gistsCreate.mockResolvedValue(buildGistResponse());

      await provider.deploySingleFile(
        'gho_userToken',
        'test-mcp-server',
        files,
        'A test MCP server',
        [{ name: 'list_posts', description: 'List posts' }],
        true,
      );

      expect((Octokit as unknown as jest.Mock)).toHaveBeenCalledWith(
        expect.objectContaining({ auth: 'gho_userToken' }),
      );
    });

    it('creates the gist and returns its URL/id/rawUrl on success', async () => {
      gistsCreate.mockResolvedValue(buildGistResponse());

      const result = await provider.deploySingleFile(
        'gho_userToken',
        'test-mcp-server',
        files,
        'A test MCP server',
        [{ name: 'list_posts', description: 'List posts' }],
        true,
      );

      expect(result).toEqual({
        success: true,
        gistUrl: 'https://gist.github.com/octocat/abc123',
        gistId: 'abc123',
        rawUrl: 'https://gist.githubusercontent.com/octocat/abc123/raw/test-mcp-server.ts',
      });
      expect(gistsCreate).toHaveBeenCalledWith(
        expect.objectContaining({ public: true }),
      );
    });

    it('fails with a clear "connect GitHub" error - not a server-token fallback - when no user token is supplied', async () => {
      const result = await provider.deploySingleFile(
        '',
        'test-mcp-server',
        files,
        'A test MCP server',
        [{ name: 'list_posts', description: 'List posts' }],
        true,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Connect your GitHub account');
      // No Octokit client should even be constructed for the doomed call.
      expect(gistsCreate).not.toHaveBeenCalled();
    });
  });

  describe('createGist / deploy (legacy multi-file path)', () => {
    it('builds the Octokit client from the passed user token', async () => {
      gistsCreate.mockResolvedValue(buildGistResponse());

      await provider.deploy('gho_userToken', 'test-mcp-server', files, 'A test MCP server', true);

      expect((Octokit as unknown as jest.Mock)).toHaveBeenCalledWith(
        expect.objectContaining({ auth: 'gho_userToken' }),
      );
      expect(gistsCreate).toHaveBeenCalled();
    });

    it('fails clearly when no user token is supplied', async () => {
      const result = await provider.createGist('', files, 'A test MCP server', true);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Connect your GitHub account');
      expect(gistsCreate).not.toHaveBeenCalled();
    });
  });

  describe('updateGist', () => {
    it('builds the Octokit client from the passed user token and updates the gist', async () => {
      gistsUpdate.mockResolvedValue(buildGistResponse());

      const result = await provider.updateGist('gho_userToken', 'abc123', files, 'Updated');

      expect((Octokit as unknown as jest.Mock)).toHaveBeenCalledWith(
        expect.objectContaining({ auth: 'gho_userToken' }),
      );
      expect(gistsUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ gist_id: 'abc123', description: 'Updated' }),
      );
      expect(result.success).toBe(true);
    });

    it('fails clearly, without calling GitHub, when no user token is supplied', async () => {
      const result = await provider.updateGist('', 'abc123', files, 'Updated');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Connect your GitHub account');
      expect(gistsUpdate).not.toHaveBeenCalled();
    });
  });

  describe('deleteGist', () => {
    it('builds the Octokit client from the passed user token and deletes the gist', async () => {
      gistsDelete.mockResolvedValue({});

      const result = await provider.deleteGist('gho_userToken', 'abc123');

      expect((Octokit as unknown as jest.Mock)).toHaveBeenCalledWith(
        expect.objectContaining({ auth: 'gho_userToken' }),
      );
      expect(gistsDelete).toHaveBeenCalledWith({ gist_id: 'abc123' });
      expect(result).toBe(true);
    });

    it('returns false (does not throw, does not fall back) when no user token is supplied', async () => {
      const result = await provider.deleteGist('', 'abc123');

      expect(result).toBe(false);
      expect(gistsDelete).not.toHaveBeenCalled();
    });
  });

  describe('getGist', () => {
    it('builds the Octokit client from the passed user token', async () => {
      gistsGet.mockResolvedValue(buildGistResponse());

      const result = await provider.getGist('gho_userToken', 'abc123');

      expect((Octokit as unknown as jest.Mock)).toHaveBeenCalledWith(
        expect.objectContaining({ auth: 'gho_userToken' }),
      );
      expect(result.success).toBe(true);
      expect(result.gistId).toBe('abc123');
    });
  });
});
