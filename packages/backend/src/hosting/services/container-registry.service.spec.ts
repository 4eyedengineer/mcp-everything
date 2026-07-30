import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ContainerRegistryService } from './container-registry.service';

const execMock = jest.fn();
jest.mock('child_process', () => ({
  exec: (...args: any[]) => (execMock as any)(...args),
}));

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
});
