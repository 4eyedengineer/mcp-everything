import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { HostingService } from './hosting.service';
import { HostedServer } from '../database/entities/hosted-server.entity';
import { Deployment } from '../database/entities/deployment.entity';
import { ContainerRegistryService } from './services/container-registry.service';
import { ManifestGeneratorService } from './services/manifest-generator.service';
import { GitOpsService } from './services/gitops.service';
import { LocalDockerHostingService } from './services/local-docker-hosting.service';
import { TokenEncryptionService } from '../common/token-encryption/token-encryption.service';

describe('HostingService', () => {
  let service: HostingService;
  let hostedServerRepo: { create: jest.Mock; save: jest.Mock; findOne: jest.Mock; createQueryBuilder: jest.Mock };
  let deploymentRepo: { findOne: jest.Mock };
  let containerRegistryService: {
    buildImage: jest.Mock;
    pushImage: jest.Mock;
    buildAndPush: jest.Mock;
    deleteImage: jest.Mock;
  };
  let manifestGeneratorService: { generateManifests: jest.Mock; generateKustomization: jest.Mock };
  let gitOpsService: { deployServer: jest.Mock; updateServer: jest.Mock; removeServer: jest.Mock };
  let localDockerHostingService: {
    containerNameFor: jest.Mock;
    httpHostPortFor: jest.Mock;
    buildImage: jest.Mock;
    startAndVerify: jest.Mock;
    stopContainer: jest.Mock;
    getLogs: jest.Mock;
  };
  /**
   * A real-behaviour fake rather than a pass-through: encrypt/decrypt must
   * actually round-trip (and must be able to fail) for the restart-env tests
   * to mean anything, but AES key management is TokenEncryptionService's own
   * tested concern, not HostingService's.
   */
  let tokenEncryptionService: {
    enabled: boolean;
    encrypt: jest.Mock;
    decrypt: jest.Mock;
  };
  let hostingMode: 'kubernetes' | 'docker-run';

  const mockConfigService = {
    get: jest.fn((key: string, defaultValue?: unknown) => {
      if (key === 'HOSTING_MODE') return hostingMode;
      return defaultValue;
    }),
  };

  const baseDeployment = {
    id: 'deploy-1',
    conversationId: 'conv-1',
    userId: 'user-1',
    serverName: 'github-api-mcp',
    description: 'A generated server',
    localPath: '/generated-servers/conv-1',
    tools: [{ name: 'get_user', description: 'Fetch a user', inputSchema: {} }],
    envVars: [{ name: 'GITHUB_TOKEN', required: false }],
  } as unknown as Deployment;

  beforeEach(async () => {
    jest.clearAllMocks();
    hostingMode = 'kubernetes';

    hostedServerRepo = {
      create: jest.fn((data) => ({ ...data })),
      save: jest.fn(async (entity) => entity),
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(),
    };
    deploymentRepo = { findOne: jest.fn() };
    containerRegistryService = {
      buildImage: jest.fn(),
      pushImage: jest.fn().mockResolvedValue(undefined),
      buildAndPush: jest.fn(),
      deleteImage: jest.fn(),
    };
    tokenEncryptionService = {
      enabled: true,
      encrypt: jest.fn((plaintext: string) =>
        tokenEncryptionService.enabled ? `enc(${plaintext})` : undefined,
      ),
      decrypt: jest.fn((payload?: string | null) => {
        if (!tokenEncryptionService.enabled || !payload) return undefined;
        const match = /^enc\((.*)\)$/s.exec(payload);
        return match ? match[1] : undefined;
      }),
    };
    manifestGeneratorService = {
      generateManifests: jest.fn().mockReturnValue({
        deployment: 'kind: Deployment\nreplicas: 1',
        service: 'kind: Service',
        ingress: 'kind: Ingress',
      }),
      generateKustomization: jest.fn().mockReturnValue('kind: Kustomization'),
    };
    gitOpsService = {
      deployServer: jest.fn().mockResolvedValue({ success: true, commitSha: 'abc123' }),
      updateServer: jest.fn().mockResolvedValue({ success: true }),
      removeServer: jest.fn().mockResolvedValue({ success: true }),
    };
    localDockerHostingService = {
      containerNameFor: jest.fn((id: string) => `mcp-hosted-${id}`),
      httpHostPortFor: jest.fn((id: string) => 20000 + id.length),
      buildImage: jest.fn(),
      startAndVerify: jest.fn(),
      stopContainer: jest.fn(),
      getLogs: jest.fn(),
    };

    service = await buildService();
  });

  /**
   * HostingService reads HOSTING_MODE from ConfigService once, in its
   * constructor, so `hostingMode` (the module-level test var read by
   * mockConfigService.get) must be set BEFORE building the module - tests
   * for the docker-run mode rebuild the service via this helper after
   * flipping it, rather than relying on the outer beforeEach's instance.
   */
  async function buildService(): Promise<HostingService> {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HostingService,
        { provide: getRepositoryToken(HostedServer), useValue: hostedServerRepo },
        { provide: getRepositoryToken(Deployment), useValue: deploymentRepo },
        { provide: ContainerRegistryService, useValue: containerRegistryService },
        { provide: ManifestGeneratorService, useValue: manifestGeneratorService },
        { provide: GitOpsService, useValue: gitOpsService },
        { provide: LocalDockerHostingService, useValue: localDockerHostingService },
        { provide: TokenEncryptionService, useValue: tokenEncryptionService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    return module.get<HostingService>(HostingService);
  }

  describe('deployToCloud', () => {
    it('throws NotFoundException when no deployment exists for the conversation', async () => {
      deploymentRepo.findOne.mockResolvedValue(null);

      await expect(service.deployToCloud('conv-1', 'user-1')).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when the deployment has no serverName', async () => {
      deploymentRepo.findOne.mockResolvedValue({ ...baseDeployment, serverName: undefined });

      await expect(service.deployToCloud('conv-1', 'user-1')).rejects.toThrow(BadRequestException);
    });

    it('always generates a serverId that is a valid Docker tag / K8s DNS label component (never ending in a separator)', async () => {
      deploymentRepo.findOne.mockResolvedValue(baseDeployment);
      containerRegistryService.buildImage.mockResolvedValue('ghcr.io/owner/repo/x:latest');

      // Run many times since the suffix is random - regression guard for the
      // nanoid-default-alphabet bug (suffix could end in '-' or '_').
      for (let i = 0; i < 25; i++) {
        const result = await service.deployToCloud('conv-1', 'user-1');
        expect(result.serverId).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
        expect(result.serverId).not.toMatch(/[-_]$/);
      }
    });

    describe('kubernetes mode (default)', () => {
      it('builds, pushes, generates manifests, commits to GitOps, and reports running', async () => {
        deploymentRepo.findOne.mockResolvedValue(baseDeployment);
        containerRegistryService.buildImage.mockResolvedValue('ghcr.io/owner/repo/x:latest');

        const result = await service.deployToCloud('conv-1', 'user-1');

        expect(result.success).toBe(true);
        expect(result.status).toBe('running');
        expect(result.endpointUrl).toMatch(/^https:\/\//);
        expect(containerRegistryService.buildImage).toHaveBeenCalledWith(
          baseDeployment.localPath,
          result.serverId,
          'latest',
        );
        expect(containerRegistryService.pushImage).toHaveBeenCalledWith(
          'ghcr.io/owner/repo/x:latest',
        );
        expect(gitOpsService.deployServer).toHaveBeenCalled();
        expect(localDockerHostingService.buildImage).not.toHaveBeenCalled();
      });

      /**
       * Defect: ContainerRegistryService returns an image reference that
       * already carries its tag, and HostingService also passed
       * `imageTag: 'latest'`, so ManifestGeneratorService emitted
       * `...:latest:latest` -> InvalidImageName -> the pod could never start.
       * Assert on the object the real caller hands the manifest generator,
       * which is the seam where the two were being combined.
       */
      it('passes the manifest generator the full image reference and no separate tag', async () => {
        deploymentRepo.findOne.mockResolvedValue(baseDeployment);
        containerRegistryService.buildImage.mockResolvedValue(
          'ghcr.io/owner/mcp-servers/x:latest',
        );

        await service.deployToCloud('conv-1', 'user-1');

        const config = manifestGeneratorService.generateManifests.mock.calls[0][0];
        expect(config.dockerImage).toBe('ghcr.io/owner/mcp-servers/x:latest');
        expect(config.imageTag).toBeUndefined();
      });

      /**
       * 'pushing' is a declared HostedServerStatus with DB CHECK constraints
       * and its own stage in the deploy-progress UI, but nothing ever set it -
       * the bar jumped building -> deploying past a stage users were shown.
       */
      it('reports the pushing stage between building and deploying', async () => {
        deploymentRepo.findOne.mockResolvedValue(baseDeployment);
        containerRegistryService.buildImage.mockResolvedValue('ghcr.io/owner/repo/x:latest');

        // save() is handed the same mutated entity every time, so the status
        // has to be snapshotted at call time rather than read back off
        // save.mock.calls afterwards.
        const statuses: string[] = [];
        hostedServerRepo.save.mockImplementation(async (entity: { status: string }) => {
          statuses.push(entity.status);
          return entity;
        });

        await service.deployToCloud('conv-1', 'user-1');

        expect(statuses).toContain('pushing');
        expect(statuses.indexOf('building')).toBeLessThan(statuses.indexOf('pushing'));
        expect(statuses.indexOf('pushing')).toBeLessThan(statuses.indexOf('deploying'));
      });

      it('does not push an image that failed to build', async () => {
        deploymentRepo.findOne.mockResolvedValue(baseDeployment);
        containerRegistryService.buildImage.mockRejectedValue(new Error('Docker build failed'));

        await service.deployToCloud('conv-1', 'user-1');

        expect(containerRegistryService.pushImage).not.toHaveBeenCalled();
      });

      it('reports failed with the real error when the registry build fails', async () => {
        deploymentRepo.findOne.mockResolvedValue(baseDeployment);
        containerRegistryService.buildImage.mockRejectedValue(
          new Error('Docker build failed: docker: not found'),
        );

        const result = await service.deployToCloud('conv-1', 'user-1');

        expect(result.success).toBe(false);
        expect(result.status).toBe('failed');
        expect(result.error).toContain('docker: not found');
      });

      it('reports failed with the real error when the push fails', async () => {
        deploymentRepo.findOne.mockResolvedValue(baseDeployment);
        containerRegistryService.buildImage.mockResolvedValue('ghcr.io/owner/repo/x:latest');
        containerRegistryService.pushImage.mockRejectedValue(
          new Error('Docker push failed: unauthorized'),
        );

        const result = await service.deployToCloud('conv-1', 'user-1');

        expect(result.success).toBe(false);
        expect(result.status).toBe('failed');
        expect(result.error).toContain('unauthorized');
        expect(gitOpsService.deployServer).not.toHaveBeenCalled();
      });

      it('reports failed when the GitOps commit fails', async () => {
        deploymentRepo.findOne.mockResolvedValue(baseDeployment);
        containerRegistryService.buildImage.mockResolvedValue('ghcr.io/owner/repo/x:latest');
        gitOpsService.deployServer.mockResolvedValue({ success: false, error: 'auth failed' });

        const result = await service.deployToCloud('conv-1', 'user-1');

        expect(result.success).toBe(false);
        expect(result.error).toContain('auth failed');
      });

      /**
       * Deployment is ON DELETE CASCADE from conversations while HostedServer
       * is only SET NULL, so the source path has to be copied onto the hosted
       * server or deleting the chat leaves a live, unrebuildable server.
       */
      it('copies localPath onto the hosted server instead of relying on the deployment row', async () => {
        deploymentRepo.findOne.mockResolvedValue(baseDeployment);
        containerRegistryService.buildImage.mockResolvedValue('ghcr.io/owner/repo/x:latest');

        await service.deployToCloud('conv-1', 'user-1');

        expect(hostedServerRepo.create).toHaveBeenCalledWith(
          expect.objectContaining({ localPath: '/generated-servers/conv-1' }),
        );
      });
    });

    describe('docker-run mode', () => {
      beforeEach(async () => {
        hostingMode = 'docker-run';
        service = await buildService();
      });

      it('builds locally, starts+verifies the container, and reports running with handshake evidence in config', async () => {
        deploymentRepo.findOne.mockResolvedValue(baseDeployment);
        localDockerHostingService.buildImage.mockResolvedValue('mcp-local/x:latest');
        localDockerHostingService.startAndVerify.mockResolvedValue({
          containerName: 'mcp-hosted-x',
          handshake: {
            success: true,
            protocolVersion: '2025-11-25',
            serverInfo: { name: 'github-api-mcp', version: '1.0.0' },
            tools: [{ name: 'get_user', description: 'Fetch a user' }],
          },
        });

        const result = await service.deployToCloud('conv-1', 'user-1', { GITHUB_TOKEN: 'abc' });

        expect(result.success).toBe(true);
        expect(result.status).toBe('running');
        expect(result.endpointUrl).toMatch(/^docker-exec:\/\//);
        expect(containerRegistryService.buildImage).not.toHaveBeenCalled();
        expect(containerRegistryService.pushImage).not.toHaveBeenCalled();
        expect(gitOpsService.deployServer).not.toHaveBeenCalled();
        expect(localDockerHostingService.startAndVerify).toHaveBeenCalledWith(
          result.serverId,
          'mcp-local/x:latest',
          { GITHUB_TOKEN: 'abc' },
        );

        // The saved HostedServer should carry real handshake evidence, not a
        // blind assumption of success.
        const savedCalls = hostedServerRepo.save.mock.calls.map((c) => c[0]);
        const finalSave = savedCalls[savedCalls.length - 1];
        expect(finalSave.config).toMatchObject({
          mode: 'docker-run',
          containerName: 'mcp-hosted-x',
          handshake: { toolCount: 1, toolNames: ['get_user'] },
        });
      });

      it('reports a real http://localhost endpointUrl when MCP_TRANSPORT=http is requested', async () => {
        deploymentRepo.findOne.mockResolvedValue(baseDeployment);
        localDockerHostingService.buildImage.mockResolvedValue('mcp-local/x:latest');
        localDockerHostingService.startAndVerify.mockResolvedValue({
          containerName: 'mcp-hosted-x',
          handshake: {
            success: true,
            transport: 'http',
            protocolVersion: '2025-11-25',
            serverInfo: { name: 'github-api-mcp', version: '1.0.0' },
            tools: [{ name: 'get_user', description: 'Fetch a user' }],
          },
        });

        const result = await service.deployToCloud('conv-1', 'user-1', { MCP_TRANSPORT: 'http' });

        expect(result.success).toBe(true);
        expect(result.endpointUrl).toMatch(/^http:\/\/localhost:\d+$/);
        expect(localDockerHostingService.httpHostPortFor).toHaveBeenCalledWith(result.serverId);

        const savedCalls = hostedServerRepo.save.mock.calls.map((c) => c[0]);
        const finalSave = savedCalls[savedCalls.length - 1];
        expect(finalSave.statusMessage).toContain('Verified via http MCP handshake');
      });

      it('reports failed with the real handshake error when the container never becomes a working MCP server', async () => {
        deploymentRepo.findOne.mockResolvedValue(baseDeployment);
        localDockerHostingService.buildImage.mockResolvedValue('mcp-local/x:latest');
        localDockerHostingService.startAndVerify.mockRejectedValue(
          new Error('Timed out waiting for response to \'initialize\' after 15000ms'),
        );

        const result = await service.deployToCloud('conv-1', 'user-1');

        expect(result.success).toBe(false);
        expect(result.status).toBe('failed');
        expect(result.error).toContain('Timed out waiting for response');
      });

      it('reports failed with a clear build error and never calls startAndVerify', async () => {
        deploymentRepo.findOne.mockResolvedValue(baseDeployment);
        localDockerHostingService.buildImage.mockRejectedValue(
          new Error('Docker build failed: invalid reference format'),
        );

        const result = await service.deployToCloud('conv-1', 'user-1');

        expect(result.success).toBe(false);
        expect(result.error).toContain('invalid reference format');
        expect(localDockerHostingService.startAndVerify).not.toHaveBeenCalled();
      });
    });
  });

  describe('stopServer / startServer / deleteServer routing by mode', () => {
    function dockerRunServer(overrides: Partial<HostedServer> = {}): HostedServer {
      return {
        id: '1',
        serverId: 'srv-1',
        serverName: 'github-api-mcp',
        status: 'running',
        dockerImage: 'mcp-local/srv-1:latest',
        config: { mode: 'docker-run', containerName: 'mcp-hosted-srv-1', localPath: '/dir' },
        ...overrides,
      } as HostedServer;
    }

    function k8sServer(overrides: Partial<HostedServer> = {}): HostedServer {
      return {
        id: '2',
        serverId: 'srv-2',
        serverName: 'other-mcp',
        status: 'running',
        dockerImage: 'ghcr.io/owner/repo/srv-2:latest',
        config: null,
        ...overrides,
      } as HostedServer;
    }

    it('stopServer uses LocalDockerHostingService for docker-run servers and skips GitOps', async () => {
      hostedServerRepo.findOne.mockResolvedValue(dockerRunServer());

      await service.stopServer('srv-1');

      expect(localDockerHostingService.stopContainer).toHaveBeenCalledWith('srv-1');
      expect(gitOpsService.updateServer).not.toHaveBeenCalled();
    });

    it('stopServer uses GitOps for kubernetes-mode servers', async () => {
      hostedServerRepo.findOne.mockResolvedValue(k8sServer());

      await service.stopServer('srv-2');

      expect(gitOpsService.updateServer).toHaveBeenCalled();
      expect(localDockerHostingService.stopContainer).not.toHaveBeenCalled();
    });

    it('startServer rejects a server that is not stopped', async () => {
      hostedServerRepo.findOne.mockResolvedValue(dockerRunServer({ status: 'running' }));

      await expect(service.startServer('srv-1')).rejects.toThrow(BadRequestException);
    });

    it('startServer re-verifies the MCP handshake for docker-run servers', async () => {
      hostedServerRepo.findOne.mockResolvedValue(
        dockerRunServer({ status: 'stopped', localPath: '/dir' }),
      );
      localDockerHostingService.startAndVerify.mockResolvedValue({
        containerName: 'mcp-hosted-srv-1',
        handshake: { success: true, tools: [{ name: 'get_user' }] },
      });

      await service.startServer('srv-1');

      expect(localDockerHostingService.startAndVerify).toHaveBeenCalledWith(
        'srv-1',
        'mcp-local/srv-1:latest',
        expect.any(Object),
      );
    });

    /**
     * Defect: startServer passed `{}` for env vars. LocalDockerHostingService
     * defaults MCP_TRANSPORT to stdio when it is absent, and stdio publishes
     * no port - so a stopped-then-started HTTP server came back up
     * unreachable at the http://localhost:<port> endpointUrl its own row still
     * advertises, and any user-supplied API keys were silently dropped.
     */
    describe('startServer restores the env vars a docker-run server was deployed with', () => {
      function stoppedHttpServer(): HostedServer {
        return dockerRunServer({
          status: 'stopped',
          localPath: '/dir',
          endpointUrl: 'http://localhost:20007',
          config: {
            mode: 'docker-run',
            containerName: 'mcp-hosted-srv-1',
            transportEnv: { MCP_TRANSPORT: 'http', PORT: '3000' },
          },
          deployEnvEncrypted: 'enc({"MCP_TRANSPORT":"http","PORT":"3000","API_KEY":"sk-secret"})',
        });
      }

      beforeEach(() => {
        localDockerHostingService.startAndVerify.mockResolvedValue({
          containerName: 'mcp-hosted-srv-1',
          handshake: { success: true, transport: 'http', tools: [{ name: 'get_user' }] },
        });
      });

      it('restarts with the same transport, port and secrets', async () => {
        hostedServerRepo.findOne.mockResolvedValue(stoppedHttpServer());

        await service.startServer('srv-1');

        expect(localDockerHostingService.startAndVerify).toHaveBeenCalledWith(
          'srv-1',
          'mcp-local/srv-1:latest',
          { MCP_TRANSPORT: 'http', PORT: '3000', API_KEY: 'sk-secret' },
        );
      });

      it('still restores the transport when the secrets cannot be decrypted', async () => {
        tokenEncryptionService.enabled = false;
        hostedServerRepo.findOne.mockResolvedValue(stoppedHttpServer());

        await service.startServer('srv-1');

        // The half that keeps the advertised endpointUrl dialable must
        // survive even with no usable encryption key; only the secret half is
        // allowed to be lost.
        expect(localDockerHostingService.startAndVerify).toHaveBeenCalledWith(
          'srv-1',
          'mcp-local/srv-1:latest',
          { MCP_TRANSPORT: 'http', PORT: '3000' },
        );
      });
    });

    it('deployToCloud persists the deploy-time env vars for a later restart', async () => {
      hostingMode = 'docker-run';
      service = await buildService();
      deploymentRepo.findOne.mockResolvedValue(baseDeployment);
      localDockerHostingService.buildImage.mockResolvedValue('mcp-local/x:latest');
      localDockerHostingService.startAndVerify.mockResolvedValue({
        containerName: 'mcp-hosted-x',
        handshake: { success: true, transport: 'http', tools: [] },
      });

      await service.deployToCloud('conv-1', 'user-1', {
        MCP_TRANSPORT: 'http',
        API_KEY: 'sk-secret',
      });

      const saved = hostedServerRepo.save.mock.calls.map((c) => c[0]).pop();
      // Transport settings in the clear (not secrets, must survive a missing key)...
      expect(saved.config.transportEnv).toEqual({ MCP_TRANSPORT: 'http' });
      // ...secrets only ever encrypted - `env_var_names` exists precisely so
      // that values are never stored in the clear.
      expect(saved.deployEnvEncrypted).toBe('enc({"MCP_TRANSPORT":"http","API_KEY":"sk-secret"})');
      expect(JSON.stringify(saved.config)).not.toContain('sk-secret');
    });

    /**
     * Deleting the conversation CASCADE-deletes the Deployment that used to
     * be the only holder of localPath. The hosted server (SET NULL) survives,
     * so it must carry its own copy or it can never be restarted.
     */
    it('startServer works for a docker-run server whose conversation/deployment is gone', async () => {
      hostedServerRepo.findOne.mockResolvedValue(
        dockerRunServer({
          status: 'stopped',
          conversationId: null,
          localPath: '/generated-servers/conv-1',
          // No `localPath` inside config - only the column has it.
          config: { mode: 'docker-run', containerName: 'mcp-hosted-srv-1' },
        }),
      );
      localDockerHostingService.startAndVerify.mockResolvedValue({
        containerName: 'mcp-hosted-srv-1',
        handshake: { success: true, tools: [] },
      });

      await expect(service.startServer('srv-1')).resolves.toBeUndefined();
      expect(localDockerHostingService.startAndVerify).toHaveBeenCalled();
    });

    it('startServer still refuses when no source path was ever recorded', async () => {
      hostedServerRepo.findOne.mockResolvedValue(
        dockerRunServer({
          status: 'stopped',
          localPath: null,
          config: { mode: 'docker-run', containerName: 'mcp-hosted-srv-1' },
        }),
      );

      await expect(service.startServer('srv-1')).rejects.toThrow(BadRequestException);
    });

    it('stop/start of a k8s server generate manifests with the stored tagged reference, unmodified', async () => {
      hostedServerRepo.findOne.mockResolvedValue(k8sServer({ status: 'stopped' }));

      await service.startServer('srv-2');

      const config = manifestGeneratorService.generateManifests.mock.calls[0][0];
      expect(config.dockerImage).toBe('ghcr.io/owner/repo/srv-2:latest');
      expect(config.imageTag).toBeUndefined();
    });

    it('stop/start of a legacy k8s row with an untagged image falls back to the image_tag column', async () => {
      hostedServerRepo.findOne.mockResolvedValue(
        k8sServer({ status: 'stopped', dockerImage: 'ghcr.io/owner/repo/srv-2', imageTag: 'v2' }),
      );

      await service.startServer('srv-2');

      const config = manifestGeneratorService.generateManifests.mock.calls[0][0];
      expect(config.dockerImage).toBe('ghcr.io/owner/repo/srv-2:v2');
    });

    it('does not mistake a registry host:port for a tag', async () => {
      hostedServerRepo.findOne.mockResolvedValue(
        k8sServer({ status: 'stopped', dockerImage: 'localhost:5000/srv-2', imageTag: 'latest' }),
      );

      await service.startServer('srv-2');

      const config = manifestGeneratorService.generateManifests.mock.calls[0][0];
      expect(config.dockerImage).toBe('localhost:5000/srv-2:latest');
    });

    it('deleteServer stops the container for docker-run servers instead of touching GitOps/registry', async () => {
      hostedServerRepo.findOne.mockResolvedValue(dockerRunServer());

      await service.deleteServer('srv-1');

      expect(localDockerHostingService.stopContainer).toHaveBeenCalledWith('srv-1');
      expect(gitOpsService.removeServer).not.toHaveBeenCalled();
      expect(containerRegistryService.deleteImage).not.toHaveBeenCalled();
    });

    it('deleteServer uses GitOps + registry deletion for kubernetes-mode servers', async () => {
      hostedServerRepo.findOne.mockResolvedValue(k8sServer());

      await service.deleteServer('srv-2');

      expect(gitOpsService.removeServer).toHaveBeenCalledWith('srv-2');
      expect(containerRegistryService.deleteImage).toHaveBeenCalledWith('srv-2');
    });

    it('getServerLogs returns real docker logs for docker-run servers', async () => {
      hostedServerRepo.findOne.mockResolvedValue(dockerRunServer());
      localDockerHostingService.getLogs.mockResolvedValue(['line 1', 'line 2']);

      const result = await service.getServerLogs('srv-1', { lines: 50 });

      expect(result.logs).toEqual(['line 1', 'line 2']);
      expect(localDockerHostingService.getLogs).toHaveBeenCalledWith('srv-1', 50);
    });

    it('getServerLogs still stubs K8s-mode logs (no cluster to query)', async () => {
      hostedServerRepo.findOne.mockResolvedValue(k8sServer());

      const result = await service.getServerLogs('srv-2', {});

      expect(result.logs).toEqual([]);
      expect(result.message).toMatch(/not yet implemented/);
    });

    it('throws NotFoundException for a server that does not exist', async () => {
      hostedServerRepo.findOne.mockResolvedValue(null);

      await expect(service.stopServer('missing')).rejects.toThrow(NotFoundException);
    });
  });
});
