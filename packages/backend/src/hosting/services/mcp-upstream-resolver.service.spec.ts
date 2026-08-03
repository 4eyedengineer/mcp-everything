import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ServiceUnavailableException } from '@nestjs/common';
import { McpUpstreamResolver } from './mcp-upstream-resolver.service';
import { LocalDockerHostingService } from './local-docker-hosting.service';
import { HostedServer } from '../../database/entities/hosted-server.entity';
import { MCP_SERVICE_PORT, objectNameFor } from './manifest-generator.service';

describe('McpUpstreamResolver', () => {
  let resolver: McpUpstreamResolver;
  let localDocker: { httpHostPortFor: jest.Mock };

  const server = (overrides: Partial<HostedServer> = {}): HostedServer =>
    ({
      serverId: 'srv-abc123',
      status: 'running',
      statusMessage: null,
      k8sNamespace: 'mcp-servers',
      k8sDeploymentName: null,
      endpointUrl: 'http://localhost:3000/api/hosting/servers/srv-abc123/mcp',
      config: null,
      ...overrides,
    }) as unknown as HostedServer;

  beforeEach(async () => {
    localDocker = { httpHostPortFor: jest.fn().mockReturnValue(24242) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        McpUpstreamResolver,
        { provide: LocalDockerHostingService, useValue: localDocker },
        {
          provide: ConfigService,
          useValue: { get: jest.fn((_k: string, d?: unknown) => d) },
        },
      ],
    }).compile();

    resolver = module.get(McpUpstreamResolver);
  });

  describe('kubernetes mode', () => {
    it('targets the per-server ClusterIP Service that ManifestGeneratorService creates', () => {
      // The object name and port are imported from the manifest generator, so
      // this asserts the gateway and the manifests cannot drift apart.
      expect(resolver.resolve(server())).toBe(
        `http://${objectNameFor('srv-abc123')}.mcp-servers.svc.cluster.local:${MCP_SERVICE_PORT}/mcp`,
      );
    });

    it('uses the namespace recorded on the row, not the backend default', () => {
      expect(resolver.resolve(server({ k8sNamespace: 'tenant-b' }))).toContain(
        '.tenant-b.svc.cluster.local',
      );
    });

    it('prefers the recorded deployment name when present', () => {
      expect(resolver.resolve(server({ k8sDeploymentName: 'mcp-legacy-name' }))).toContain(
        'http://mcp-legacy-name.mcp-servers.svc.cluster.local',
      );
    });
  });

  describe('docker-run mode', () => {
    it('targets the deterministic loopback port for an HTTP-transport server', () => {
      const result = resolver.resolve(
        server({
          config: { mode: 'docker-run', transportEnv: { MCP_TRANSPORT: 'http' } } as never,
        }),
      );

      // 127.0.0.1 rather than `localhost`, which can resolve to ::1 while
      // `docker run -p` bound only IPv4.
      expect(result).toBe('http://127.0.0.1:24242/mcp');
      expect(localDocker.httpHostPortFor).toHaveBeenCalledWith('srv-abc123');
    });

    it('refuses a stdio server with a specific reason rather than dialling nothing', () => {
      expect(() =>
        resolver.resolve(
          server({
            config: { mode: 'docker-run', transportEnv: { MCP_TRANSPORT: 'stdio' } } as never,
            endpointUrl: 'docker-exec://mcp-hosted-srv-abc123',
          }),
        ),
      ).toThrow(/stdio transport and has no HTTP endpoint/i);
    });

    it('falls back to the legacy endpointUrl shape for rows predating transportEnv', () => {
      const result = resolver.resolve(
        server({
          config: { mode: 'docker-run' } as never,
          endpointUrl: 'http://localhost:20007',
        }),
      );

      expect(result).toBe('http://127.0.0.1:24242/mcp');
    });

    it('treats a legacy docker-exec:// row as stdio', () => {
      expect(() =>
        resolver.resolve(
          server({
            config: { mode: 'docker-run' } as never,
            endpointUrl: 'docker-exec://mcp-hosted-srv-abc123',
          }),
        ),
      ).toThrow(ServiceUnavailableException);
    });
  });

  describe('server state', () => {
    it.each(['pending', 'building', 'deploying', 'stopped', 'failed', 'deleted'])(
      'refuses to resolve a server in status %s',
      (status) => {
        expect(() => resolver.resolve(server({ status: status as never }))).toThrow(
          ServiceUnavailableException,
        );
      },
    );

    it('names the status and message so the caller can act on it', () => {
      expect(() =>
        resolver.resolve(
          server({ status: 'failed' as never, statusMessage: 'ImagePullBackOff' }),
        ),
      ).toThrow(/failed - ImagePullBackOff/);
    });
  });
});
