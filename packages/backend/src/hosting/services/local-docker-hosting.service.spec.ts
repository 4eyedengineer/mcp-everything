import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EventEmitter } from 'events';
import { LocalDockerHostingService } from './local-docker-hosting.service';

// Mock child_process so no real docker CLI is ever invoked in tests.
const execFileMock = jest.fn();
let spawnMock: jest.Mock;

jest.mock('child_process', () => ({
  execFile: (...args: any[]) => (execFileMock as any)(...args),
  spawn: (...args: any[]) => (spawnMock as any)(...args),
}));

/** Minimal fake ChildProcess with writable stdin and emitter stdout/stderr. */
function createFakeChild() {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { writable: true, write: jest.fn(), end: jest.fn() };
  return child;
}

describe('LocalDockerHostingService', () => {
  let service: LocalDockerHostingService;

  const mockConfigService = {
    get: jest.fn((key: string, defaultValue?: string) => {
      if (key === 'DOCKER_BIN') return defaultValue ?? 'docker';
      return defaultValue;
    }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    spawnMock = jest.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [LocalDockerHostingService, { provide: ConfigService, useValue: mockConfigService }],
    }).compile();

    service = module.get<LocalDockerHostingService>(LocalDockerHostingService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('containerNameFor', () => {
    it('produces a deterministic, prefixed container name', () => {
      expect(service.containerNameFor('abc-123')).toBe('mcp-hosted-abc-123');
    });
  });

  describe('buildImage', () => {
    it('invokes docker build with a mcp-local/ tag and no push', async () => {
      execFileMock.mockImplementation((_bin, _args, _opts, cb) => {
        cb(null, { stdout: '', stderr: '' });
      });

      const image = await service.buildImage('/some/server/dir', 'my-server', 'latest');

      expect(image).toBe('mcp-local/my-server:latest');
      expect(execFileMock).toHaveBeenCalledWith(
        'docker',
        ['build', '-t', 'mcp-local/my-server:latest', '/some/server/dir'],
        expect.any(Object),
        expect.any(Function),
      );
    });

    it('wraps a failed build in a clear error', async () => {
      execFileMock.mockImplementation((_bin, _args, _opts, cb) => {
        cb(new Error('docker: not found'));
      });

      await expect(service.buildImage('/dir', 'srv')).rejects.toThrow(/Docker build failed/);
    });
  });

  describe('startAndVerify', () => {
    it('performs the initialize + tools/list handshake and resolves with tools', async () => {
      const child = createFakeChild();
      spawnMock.mockReturnValue(child);

      const promise = service.startAndVerify('srv-1', 'mcp-local/srv-1:latest', {
        GITHUB_TOKEN: 'abc',
      });

      // Let the event loop tick so the handshake's stdin-writable wait resolves.
      await new Promise((resolve) => setImmediate(resolve));

      // Respond to whatever request was written to stdin, in order.
      const respondToNext = (result: unknown) => {
        const written = child.stdin.write.mock.calls[child.stdin.write.mock.calls.length - 1][0];
        const message = JSON.parse(written);
        child.stdout.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n'));
      };

      // initialize
      await new Promise((resolve) => setImmediate(resolve));
      respondToNext({
        protocolVersion: '2025-11-25',
        serverInfo: { name: 'test-server', version: '1.0.0' },
      });

      // tools/list
      await new Promise((resolve) => setImmediate(resolve));
      respondToNext({
        tools: [{ name: 'get_user', description: 'Fetch a user' }],
      });

      const result = await promise;

      expect(result.containerName).toBe('mcp-hosted-srv-1');
      expect(result.handshake.success).toBe(true);
      expect(result.handshake.protocolVersion).toBe('2025-11-25');
      expect(result.handshake.tools).toEqual([{ name: 'get_user', description: 'Fetch a user' }]);
      expect(spawnMock).toHaveBeenCalledWith(
        'docker',
        [
          'run',
          '--rm',
          '-i',
          '--name',
          'mcp-hosted-srv-1',
          '-e',
          'GITHUB_TOKEN=abc',
          'mcp-local/srv-1:latest',
        ],
        expect.any(Object),
      );
    });

    it('throws and stops the container when the handshake times out', async () => {
      const child = createFakeChild();
      spawnMock.mockReturnValue(child);
      execFileMock.mockImplementation((_bin, _args, cb) => cb(null, { stdout: '', stderr: '' }));

      // Pass a short handshake timeout so this test doesn't wait 15s.
      const promise = service.startAndVerify('srv-2', 'mcp-local/srv-2:latest', {}, 200);

      await expect(promise).rejects.toThrow(/Timed out waiting for response/);
    });

    it('throws with the exit code and stderr when the container exits before initializing', async () => {
      const child = createFakeChild();
      spawnMock.mockReturnValue(child);
      child.stdin.writable = false;

      const promise = service.startAndVerify('srv-3', 'mcp-local/srv-3:latest', {});

      child.stderr.emit('data', Buffer.from('boom: missing dependency\n'));
      child.emit('exit', 1);

      await expect(promise).rejects.toThrow(/Container exited before it could be initialized/);
    });
  });

  describe('startAndVerify (http transport)', () => {
    let fetchMock: jest.SpiedFunction<typeof fetch>;

    afterEach(() => {
      fetchMock?.mockRestore();
    });

    it('publishes a deterministic port, waits for /health, and performs the Streamable HTTP handshake', async () => {
      const child = createFakeChild();
      spawnMock.mockReturnValue(child);

      fetchMock = jest.spyOn(global, 'fetch');

      // 1: GET /health
      fetchMock.mockResolvedValueOnce({ ok: true, status: 200, text: async () => '' } as Response);
      // 2: POST /mcp initialize
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'mcp-session-id': 'sess-1' }),
        text: async () =>
          `event: message\ndata: ${JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              protocolVersion: '2025-11-25',
              serverInfo: { name: 'http-reference-server', version: '1.0.0' },
            },
          })}\n\n`,
      } as unknown as Response);
      // 3: POST /mcp notifications/initialized (notification, no meaningful body)
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 202,
        headers: new Headers(),
        text: async () => '',
      } as unknown as Response);
      // 4: POST /mcp tools/list
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () =>
          `event: message\ndata: ${JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            result: { tools: [{ name: 'add', description: 'Adds two numbers' }] },
          })}\n\n`,
      } as unknown as Response);

      const result = await service.startAndVerify('srv-http-1', 'mcp-local/srv-http-1:latest', {
        MCP_TRANSPORT: 'http',
      });

      expect(result.containerName).toBe('mcp-hosted-srv-http-1');
      expect(result.handshake.success).toBe(true);
      expect(result.handshake.transport).toBe('http');
      expect(result.handshake.protocolVersion).toBe('2025-11-25');
      expect(result.handshake.serverInfo).toEqual({ name: 'http-reference-server', version: '1.0.0' });
      expect(result.handshake.tools).toEqual([{ name: 'add', description: 'Adds two numbers' }]);

      // No stdin JSON-RPC writes in HTTP mode.
      expect(child.stdin.write).not.toHaveBeenCalled();

      // A port was published, deterministically, and MCP_TRANSPORT=http was
      // forwarded into the container as an env var.
      const spawnArgs = spawnMock.mock.calls[0][1] as string[];
      const pIndex = spawnArgs.indexOf('-p');
      expect(pIndex).toBeGreaterThan(-1);
      expect(spawnArgs[pIndex + 1]).toBe(
        `${service.httpHostPortFor('srv-http-1')}:3000`,
      );
      expect(spawnArgs).toContain('MCP_TRANSPORT=http');

      // Every /mcp request after initialize must echo the session id back.
      const mcpCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/mcp'));
      expect(mcpCalls).toHaveLength(3);
      for (const call of mcpCalls.slice(1)) {
        const init = call[1] as RequestInit;
        expect((init.headers as Record<string, string>)['Mcp-Session-Id']).toBe('sess-1');
      }

      // Every request declares it accepts SSE, not just plain JSON.
      for (const call of mcpCalls) {
        const init = call[1] as RequestInit;
        expect((init.headers as Record<string, string>).Accept).toBe('application/json, text/event-stream');
      }
    });

    it('fails clearly when GET /health never returns 200 before the deadline', async () => {
      const child = createFakeChild();
      spawnMock.mockReturnValue(child);
      execFileMock.mockImplementation((_bin, _args, cb) => cb(null, { stdout: '', stderr: '' }));

      fetchMock = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED'));

      await expect(
        service.startAndVerify(
          'srv-http-2',
          'mcp-local/srv-http-2:latest',
          { MCP_TRANSPORT: 'http' },
          250,
        ),
      ).rejects.toThrow(/Timed out waiting for GET \/health/);
    });

    it('reports the failed initialize response when the server never issues a session id', async () => {
      const child = createFakeChild();
      spawnMock.mockReturnValue(child);
      execFileMock.mockImplementation((_bin, _args, cb) => cb(null, { stdout: '', stderr: '' }));

      fetchMock = jest.spyOn(global, 'fetch');
      fetchMock.mockResolvedValueOnce({ ok: true, status: 200, text: async () => '' } as Response);
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 400,
        headers: new Headers(),
        text: async () => 'Bad Request',
      } as unknown as Response);

      await expect(
        service.startAndVerify('srv-http-3', 'mcp-local/srv-http-3:latest', { MCP_TRANSPORT: 'http' }),
      ).rejects.toThrow(/did not return an Mcp-Session-Id header/);
    });
  });

  describe('getLogs', () => {
    it('calls docker logs --tail and splits output into lines', async () => {
      execFileMock.mockImplementation((_bin, _args, cb) => {
        cb(null, { stdout: 'line one\nline two\n', stderr: '' });
      });

      const logs = await service.getLogs('srv-1', 50);

      expect(logs).toEqual(['line one', 'line two']);
      expect(execFileMock).toHaveBeenCalledWith(
        'docker',
        ['logs', '--tail', '50', 'mcp-hosted-srv-1'],
        expect.any(Function),
      );
    });

    it('throws a clear error when docker logs fails', async () => {
      execFileMock.mockImplementation((_bin, _args, cb) => cb(new Error('no such container')));

      await expect(service.getLogs('missing')).rejects.toThrow(/Failed to fetch logs/);
    });
  });

  describe('isRunningInDocker', () => {
    it('returns true only on an exact name match', async () => {
      execFileMock.mockImplementation((_bin, _args, cb) =>
        cb(null, { stdout: 'mcp-hosted-srv-1\n', stderr: '' }),
      );
      expect(await service.isRunningInDocker('srv-1')).toBe(true);
    });

    it('returns false when docker ps fails (e.g. daemon unreachable)', async () => {
      execFileMock.mockImplementation((_bin, _args, cb) => cb(new Error('daemon unreachable')));
      expect(await service.isRunningInDocker('srv-1')).toBe(false);
    });
  });

  describe('stopContainer', () => {
    it('ends stdin and calls docker stop by name', async () => {
      const child = createFakeChild();
      spawnMock.mockReturnValue(child);
      execFileMock.mockImplementation((_bin, _args, cb) => cb(null, { stdout: '', stderr: '' }));

      // Track a container without going through the full handshake.
      (service as any).containers.set('srv-1', {
        containerName: 'mcp-hosted-srv-1',
        image: 'mcp-local/srv-1:latest',
        process: child,
        buffer: '',
        stderrBuffer: '',
        pendingResponses: new Map(),
        exited: false,
        exitCode: null,
      });

      await service.stopContainer('srv-1');

      expect(child.stdin.end).toHaveBeenCalled();
      expect(execFileMock).toHaveBeenCalledWith(
        'docker',
        ['stop', '--time', '5', 'mcp-hosted-srv-1'],
        expect.any(Function),
      );
      expect(service.isTracked('srv-1')).toBe(false);
    });

    it('does not throw when docker stop fails because the container is already gone', async () => {
      execFileMock.mockImplementation((_bin, _args, cb) => cb(new Error('no such container')));

      await expect(service.stopContainer('never-started')).resolves.toBeUndefined();
    });
  });
});
