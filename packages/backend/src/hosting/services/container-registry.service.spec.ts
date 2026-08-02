import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { ContainerRegistryService } from './container-registry.service';

const execMock = jest.fn();
jest.mock('child_process', () => ({
  exec: (...args: any[]) => (execMock as any)(...args),
}));

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

/** Shape axios.isAxiosError checks for, so the service's 404 branches fire. */
function axiosError(status: number): Error {
  const error = new Error(`Request failed with status code ${status}`) as Error & {
    isAxiosError: boolean;
    response: { status: number };
  };
  error.isAxiosError = true;
  error.response = { status };
  return error;
}

describe('ContainerRegistryService', () => {
  let config: Record<string, string | undefined>;

  const mockConfigService = {
    get: jest.fn((key: string, defaultValue?: string) => config[key] ?? defaultValue),
  };

  /** Config is read once in the constructor, so build a fresh service per-test after setting config. */
  async function createService(
    overrides: Record<string, string | undefined> = {},
  ): Promise<ContainerRegistryService> {
    config = overrides;
    const module: TestingModule = await Test.createTestingModule({
      providers: [ContainerRegistryService, { provide: ConfigService, useValue: mockConfigService }],
    }).compile();
    return module.get<ContainerRegistryService>(ContainerRegistryService);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    config = {};
    // jest's automock replaces isAxiosError with a stub returning undefined,
    // which would disable every 404 branch under test.
    (mockedAxios as any).isAxiosError = (error: any) => !!error?.isAxiosError;
  });

  describe('getImageName', () => {
    it('throws a clear config error instead of embedding the literal "undefined" when GHCR_OWNER is unset', async () => {
      const service = await createService({});
      expect(() => service.getImageName('my-server')).toThrow(/GHCR_OWNER is not configured/);
    });

    it('builds a ghcr.io tag when GHCR_OWNER is configured', async () => {
      const service = await createService({ GHCR_OWNER: 'someowner' });
      expect(service.getImageName('my-server', 'latest')).toBe(
        'ghcr.io/someowner/mcp-servers/my-server:latest',
      );
    });

    it('uses the local registry in LOCAL_DEV mode without requiring GHCR_OWNER', async () => {
      const service = await createService({ LOCAL_DEV: 'true' });
      expect(service.getImageName('my-server')).toBe('localhost:5000/my-server:latest');
    });
  });

  describe('buildAndPush', () => {
    it('invokes the configured DOCKER_BIN (quoted) instead of a hardcoded "docker"', async () => {
      const service = await createService({
        GHCR_OWNER: 'someowner',
        DOCKER_BIN: '/mnt/c/Program Files/Docker/Docker/resources/bin/docker.exe',
      });

      // exec() is called as (cmd, options, callback) for the build (options
      // object present) but (cmd, callback) for the push (no options) -
      // handle both promisify call shapes.
      execMock.mockImplementation((_cmd: string, optsOrCb: any, maybeCb?: any) => {
        const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
        cb(null, { stdout: 'ok', stderr: '' });
      });

      const image = await service.buildAndPush('/some/dir', 'my-server', 'latest');

      expect(image).toBe('ghcr.io/someowner/mcp-servers/my-server:latest');
      // Build call
      expect(execMock.mock.calls[0][0]).toContain(
        '"/mnt/c/Program Files/Docker/Docker/resources/bin/docker.exe" build',
      );
      // Push call
      expect(execMock.mock.calls[1][0]).toContain(
        '"/mnt/c/Program Files/Docker/Docker/resources/bin/docker.exe" push',
      );
    });

    it('wraps a failed build in a clear error', async () => {
      const service = await createService({ GHCR_OWNER: 'someowner' });
      execMock.mockImplementationOnce((_cmd: string, _opts: any, cb: any) => {
        cb(new Error('docker: not found'));
      });

      await expect(service.buildAndPush('/dir', 'srv')).rejects.toThrow(/Docker build failed/);
    });
  });

  /**
   * `buildAndPush` used to be a single method, so nothing could report the
   * 'pushing' stage the HostedServer status union and the deploy-progress UI
   * both already had. The two halves are now separately callable;
   * `buildAndPush` stays as their composition.
   */
  describe('buildImage / pushImage split', () => {
    function okExec() {
      execMock.mockImplementation((_cmd: string, optsOrCb: any, maybeCb?: any) => {
        const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
        cb(null, { stdout: 'ok', stderr: '' });
      });
    }

    it('buildImage builds only - it never pushes', async () => {
      const service = await createService({ GHCR_OWNER: 'someowner' });
      okExec();

      const image = await service.buildImage('/dir', 'my-server');

      expect(image).toBe('ghcr.io/someowner/mcp-servers/my-server:latest');
      expect(execMock).toHaveBeenCalledTimes(1);
      expect(execMock.mock.calls[0][0]).toContain(' build ');
      expect(execMock.mock.calls[0][0]).not.toContain(' push ');
    });

    it('pushImage pushes the exact reference it was given', async () => {
      const service = await createService({ GHCR_OWNER: 'someowner' });
      okExec();

      await service.pushImage('ghcr.io/someowner/mcp-servers/my-server:latest');

      expect(execMock).toHaveBeenCalledTimes(1);
      expect(execMock.mock.calls[0][0]).toContain(
        'push ghcr.io/someowner/mcp-servers/my-server:latest',
      );
    });

    it('buildAndPush is still the composition of the two', async () => {
      const service = await createService({ GHCR_OWNER: 'someowner' });
      okExec();

      const image = await service.buildAndPush('/dir', 'my-server');

      expect(image).toBe('ghcr.io/someowner/mcp-servers/my-server:latest');
      expect(execMock.mock.calls[0][0]).toContain(' build ');
      expect(execMock.mock.calls[1][0]).toContain(' push ');
    });
  });

  /**
   * Every GHCR API call hardcoded `/user/packages/...` - the AUTHENTICATED
   * USER's packages. When GHCR_OWNER is an organisation (the normal setup for
   * a hosted product) the correct endpoint is `/orgs/{org}/packages/...`, so
   * every call 404'd; `deleteImage` downgrades 404 to a warning, so image
   * cleanup silently never happened and every deleted server leaked its image.
   */
  describe('GHCR user vs organisation packages API', () => {
    const ORG_URL =
      'https://api.github.com/orgs/someowner/packages/container/mcp-servers%2Fmy-server';
    const USER_URL = 'https://api.github.com/user/packages/container/mcp-servers%2Fmy-server';

    it('deletes via the org endpoint when GHCR_OWNER_TYPE=org', async () => {
      const service = await createService({
        GHCR_OWNER: 'someowner',
        GHCR_OWNER_TYPE: 'org',
        GITHUB_TOKEN: 'token',
      });
      mockedAxios.delete.mockResolvedValue({ status: 204 } as any);

      await service.deleteImage('my-server');

      expect(mockedAxios.delete).toHaveBeenCalledTimes(1);
      expect(mockedAxios.delete.mock.calls[0][0]).toBe(ORG_URL);
      // The old hardcoded endpoint must not be what we hit.
      expect(mockedAxios.get).not.toHaveBeenCalled();
    });

    it('auto-detects an organisation owner and uses the org endpoint', async () => {
      const service = await createService({ GHCR_OWNER: 'someowner', GITHUB_TOKEN: 'token' });
      mockedAxios.get.mockResolvedValue({ data: { type: 'Organization' } } as any);
      mockedAxios.delete.mockResolvedValue({ status: 204 } as any);

      await service.deleteImage('my-server');

      expect(mockedAxios.get).toHaveBeenCalledWith(
        'https://api.github.com/users/someowner',
        expect.anything(),
      );
      expect(mockedAxios.delete.mock.calls[0][0]).toBe(ORG_URL);
    });

    it('uses the authenticated-user endpoint for a user owner', async () => {
      const service = await createService({ GHCR_OWNER: 'someowner', GITHUB_TOKEN: 'token' });
      mockedAxios.get.mockResolvedValue({ data: { type: 'User' } } as any);
      mockedAxios.delete.mockResolvedValue({ status: 204 } as any);

      await service.deleteImage('my-server');

      expect(mockedAxios.delete.mock.calls[0][0]).toBe(USER_URL);
    });

    it('falls back to the other endpoint family instead of silently swallowing a 404', async () => {
      const service = await createService({
        GHCR_OWNER: 'someowner',
        GHCR_OWNER_TYPE: 'user',
        GITHUB_TOKEN: 'token',
      });
      mockedAxios.delete
        .mockRejectedValueOnce(axiosError(404))
        .mockResolvedValueOnce({ status: 204 } as any);

      await service.deleteImage('my-server');

      expect(mockedAxios.delete).toHaveBeenCalledTimes(2);
      expect(mockedAxios.delete.mock.calls[0][0]).toBe(USER_URL);
      expect(mockedAxios.delete.mock.calls[1][0]).toBe(ORG_URL);
    });

    it('only reports "not found" once BOTH endpoint families 404', async () => {
      const service = await createService({
        GHCR_OWNER: 'someowner',
        GHCR_OWNER_TYPE: 'org',
        GITHUB_TOKEN: 'token',
      });
      mockedAxios.delete.mockRejectedValue(axiosError(404));

      await expect(service.deleteImage('my-server')).resolves.toBeUndefined();
      expect(mockedAxios.delete).toHaveBeenCalledTimes(2);
    });

    it('still surfaces non-404 failures rather than retrying forever', async () => {
      const service = await createService({
        GHCR_OWNER: 'someowner',
        GHCR_OWNER_TYPE: 'org',
        GITHUB_TOKEN: 'token',
      });
      mockedAxios.delete.mockRejectedValue(axiosError(403));

      await expect(service.deleteImage('my-server')).rejects.toThrow(/Failed to delete image/);
      expect(mockedAxios.delete).toHaveBeenCalledTimes(1);
    });

    it('imageExists queries the org versions endpoint for an org owner', async () => {
      const service = await createService({
        GHCR_OWNER: 'someowner',
        GHCR_OWNER_TYPE: 'org',
        GITHUB_TOKEN: 'token',
      });
      mockedAxios.get.mockResolvedValue({
        data: [{ metadata: { container: { tags: ['latest'] } } }],
      } as any);

      await expect(service.imageExists('my-server', 'latest')).resolves.toBe(true);
      expect(mockedAxios.get.mock.calls[0][0]).toBe(`${ORG_URL}/versions`);
    });
  });
});
