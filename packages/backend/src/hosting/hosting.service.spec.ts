import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { HostingService } from './hosting.service';
import { UserService } from '../user/user.service';
import { UserTier } from '../subscription/tier-config';
import { HostedServer } from '../database/entities/hosted-server.entity';
import { Deployment } from '../database/entities/deployment.entity';
import { ContainerRegistryService } from './services/container-registry.service';
import { ManifestGeneratorService } from './services/manifest-generator.service';
import { K8sControlPlaneService } from './services/k8s-control-plane.service';
import { LocalDockerHostingService } from './services/local-docker-hosting.service';

describe('HostingService', () => {
  let service: HostingService;
  let hostedServerRepo: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    count: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let userService: { findById: jest.Mock };
  let deploymentRepo: { findOne: jest.Mock };
  let containerRegistryService: { buildAndPush: jest.Mock; deleteImage: jest.Mock };
  let manifestGeneratorService: { buildAll: jest.Mock; getDomain: jest.Mock };
  let k8sControlPlane: {
    isEnabled: jest.Mock;
    applyServer: jest.Mock;
    scaleServer: jest.Mock;
    deleteServer: jest.Mock;
    getLogs: jest.Mock;
  };
  let localDockerHostingService: {
    containerNameFor: jest.Mock;
    httpHostPortFor: jest.Mock;
    buildImage: jest.Mock;
    startAndVerify: jest.Mock;
    stopContainer: jest.Mock;
    getLogs: jest.Mock;
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
      // Quota counting: default to "no servers yet" so existing tests deploy.
      count: jest.fn().mockResolvedValue(0),
      createQueryBuilder: jest.fn(),
    };
    userService = {
      findById: jest.fn().mockResolvedValue({ id: 'user-1', tier: UserTier.FREE }),
    };
    deploymentRepo = { findOne: jest.fn() };
    containerRegistryService = { buildAndPush: jest.fn(), deleteImage: jest.fn() };
    manifestGeneratorService = {
      buildAll: jest.fn().mockReturnValue({ deployment: {}, service: {}, secret: undefined }),
      getDomain: jest.fn().mockReturnValue('mcp.example.com'),
    };
    k8sControlPlane = {
      isEnabled: jest.fn().mockReturnValue(true),
      applyServer: jest.fn().mockResolvedValue(undefined),
      scaleServer: jest.fn().mockResolvedValue(undefined),
      deleteServer: jest.fn().mockResolvedValue(undefined),
      getLogs: jest.fn().mockResolvedValue([]),
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
        { provide: K8sControlPlaneService, useValue: k8sControlPlane },
        { provide: LocalDockerHostingService, useValue: localDockerHostingService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: UserService, useValue: userService },
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

    describe('per-user concurrent hosted-server cap', () => {
      beforeEach(() => {
        deploymentRepo.findOne.mockResolvedValue(baseDeployment);
        containerRegistryService.buildAndPush.mockResolvedValue('ghcr.io/owner/repo/x:latest');
      });

      it('allows the deploy that fills the last free slot (free tier: limit 1, currently 0)', async () => {
        hostedServerRepo.count.mockResolvedValue(0);

        const result = await service.deployToCloud('conv-1', 'user-1');

        expect(result.success).toBe(true);
        expect(hostedServerRepo.count).toHaveBeenCalledWith({
          where: { userId: 'user-1', status: expect.anything() },
        });
      });

      it('blocks the N+1th deploy with a 403 naming the limit, the current count and the tier', async () => {
        hostedServerRepo.count.mockResolvedValue(1); // free tier limit is 1

        const error = await service
          .deployToCloud('conv-1', 'user-1')
          .then(() => null)
          .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ForbiddenException);
        const body = (error as ForbiddenException).getResponse() as Record<string, unknown>;
        expect(body.code).toBe('HOSTED_SERVER_LIMIT_EXCEEDED');
        expect(body.limit).toBe(1);
        expect(body.currentUsage).toBe(1);
        expect(body.currentTier).toBe(UserTier.FREE);
        expect(body.message).toContain('maximum of 1');
        expect(body.message).toContain('Free');
      });

      it('blocks before doing any expensive work (no image build, no GitOps commit, no row written)', async () => {
        hostedServerRepo.count.mockResolvedValue(1);

        await expect(service.deployToCloud('conv-1', 'user-1')).rejects.toThrow(ForbiddenException);

        expect(hostedServerRepo.save).not.toHaveBeenCalled();
        expect(containerRegistryService.buildAndPush).not.toHaveBeenCalled();
        expect(gitOpsService.deployServer).not.toHaveBeenCalled();
      });

      it('applies the pro tier limit (10), not the free tier limit', async () => {
        userService.findById.mockResolvedValue({ id: 'user-1', tier: UserTier.PRO });
        hostedServerRepo.count.mockResolvedValue(9);

        await expect(service.deployToCloud('conv-1', 'user-1')).resolves.toMatchObject({
          success: true,
        });

        hostedServerRepo.count.mockResolvedValue(10);
        await expect(service.deployToCloud('conv-1', 'user-1')).rejects.toThrow(ForbiddenException);
      });

      it('never counts servers for an enterprise user (unlimited)', async () => {
        userService.findById.mockResolvedValue({ id: 'user-1', tier: UserTier.ENTERPRISE });

        const result = await service.deployToCloud('conv-1', 'user-1');

        expect(result.success).toBe(true);
        expect(hostedServerRepo.count).not.toHaveBeenCalled();
      });

      it('treats a user with an unknown tier as free tier rather than unlimited', async () => {
        userService.findById.mockResolvedValue({ id: 'user-1', tier: 'legacy-plan' });
        hostedServerRepo.count.mockResolvedValue(1);

        await expect(service.deployToCloud('conv-1', 'user-1')).rejects.toThrow(ForbiddenException);
      });

      it('excludes failed and deleted servers from the count', async () => {
        hostedServerRepo.count.mockResolvedValue(0);

        await service.deployToCloud('conv-1', 'user-1');

        const where = hostedServerRepo.count.mock.calls[0][0].where;
        // TypeORM In() operator - assert on the value list it was built with.
        expect(where.status.value).toEqual(
          expect.arrayContaining(['pending', 'building', 'pushing', 'deploying', 'running', 'stopped']),
        );
        expect(where.status.value).not.toContain('failed');
        expect(where.status.value).not.toContain('deleted');
      });
    });

    it('always generates a serverId that is a valid Docker tag / K8s DNS label component (never ending in a separator)', async () => {
      deploymentRepo.findOne.mockResolvedValue(baseDeployment);
      containerRegistryService.buildAndPush.mockResolvedValue('ghcr.io/owner/repo/x:latest');

      // Run many times since the suffix is random - regression guard for the
      // nanoid-default-alphabet bug (suffix could end in '-' or '_').
      for (let i = 0; i < 25; i++) {
        const result = await service.deployToCloud('conv-1', 'user-1');
        expect(result.serverId).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
        expect(result.serverId).not.toMatch(/[-_]$/);
      }
    });

    describe('kubernetes mode (default)', () => {
      it('builds, pushes and applies the server to the cluster', async () => {
        deploymentRepo.findOne.mockResolvedValue(baseDeployment);
        containerRegistryService.buildAndPush.mockResolvedValue('ghcr.io/owner/repo/x:latest');

        const result = await service.deployToCloud('conv-1', 'user-1');

        expect(result.success).toBe(true);
        expect(result.endpointUrl).toMatch(/^https:\/\//);
        expect(containerRegistryService.buildAndPush).toHaveBeenCalledWith(
          baseDeployment.localPath,
          result.serverId,
          'latest',
        );
        expect(k8sControlPlane.applyServer).toHaveBeenCalledWith(
          expect.objectContaining({
            serverId: result.serverId,
            dockerImage: 'ghcr.io/owner/repo/x:latest',
            replicas: 1,
          }),
        );
        expect(localDockerHostingService.buildImage).not.toHaveBeenCalled();
      });

      /**
       * Regression guard for the central bug: the old code wrote 'running' the
       * moment a GitOps commit succeeded, so a pod that never started reported
       * 'running' forever. Applying objects to the API server proves only that
       * the cluster ACCEPTED them - readiness is the reconciler's call.
       */
      it('reports deploying, NOT running - readiness is the reconcilers job', async () => {
        deploymentRepo.findOne.mockResolvedValue(baseDeployment);
        containerRegistryService.buildAndPush.mockResolvedValue('ghcr.io/owner/repo/x:latest');

        const result = await service.deployToCloud('conv-1', 'user-1');

        expect(result.status).toBe('deploying');
        expect(result.status).not.toBe('running');

        const savedCalls = hostedServerRepo.save.mock.calls.map((c) => c[0]);
        const finalSave = savedCalls[savedCalls.length - 1];
        expect(finalSave.status).toBe('deploying');
        expect(finalSave.desiredState).toBe('running');
        // Nothing has been observed yet, and inventing an observation here is
        // exactly what this change removes.
        expect(finalSave.observedStatus).toBeNull();
        expect(finalSave.observedReplicas).toBeNull();
      });

      /**
       * envVars previously stopped at deployToCloud and never reached the K8s
       * path. That was masking a security bug (the manifest generator would
       * have inlined them as literal values, and GitOpsService would have
       * committed them to a public GitHub repo). They now reach the control
       * plane, which puts them in a Secret.
       */
      it('passes user env vars through to the control plane', async () => {
        deploymentRepo.findOne.mockResolvedValue(baseDeployment);
        containerRegistryService.buildAndPush.mockResolvedValue('ghcr.io/owner/repo/x:latest');

        await service.deployToCloud('conv-1', 'user-1', { GITHUB_TOKEN: 'ghp_secret' });

        expect(k8sControlPlane.applyServer).toHaveBeenCalledWith(
          expect.objectContaining({ envVars: { GITHUB_TOKEN: 'ghp_secret' } }),
        );
      });

      it('records where the objects live so the reconciler can find them', async () => {
        deploymentRepo.findOne.mockResolvedValue(baseDeployment);
        containerRegistryService.buildAndPush.mockResolvedValue('ghcr.io/owner/repo/x:latest');

        const result = await service.deployToCloud('conv-1', 'user-1');

        const savedCalls = hostedServerRepo.save.mock.calls.map((c) => c[0]);
        const finalSave = savedCalls[savedCalls.length - 1];
        expect(finalSave.k8sDeploymentName).toBe(`mcp-${result.serverId}`);
        expect(finalSave.deployedAt).toBeInstanceOf(Date);
      });

      it('reports failed with the real error when the registry build fails', async () => {
        deploymentRepo.findOne.mockResolvedValue(baseDeployment);
        containerRegistryService.buildAndPush.mockRejectedValue(
          new Error('Docker build failed: docker: not found'),
        );

        const result = await service.deployToCloud('conv-1', 'user-1');

        expect(result.success).toBe(false);
        expect(result.status).toBe('failed');
        expect(result.error).toContain('docker: not found');
      });

      it('reports failed when the cluster rejects the objects', async () => {
        deploymentRepo.findOne.mockResolvedValue(baseDeployment);
        containerRegistryService.buildAndPush.mockResolvedValue('ghcr.io/owner/repo/x:latest');
        k8sControlPlane.applyServer.mockRejectedValue(
          new Error('HTTP 403: deployments.apps is forbidden'),
        );

        const result = await service.deployToCloud('conv-1', 'user-1');

        expect(result.success).toBe(false);
        expect(result.status).toBe('failed');
        expect(result.error).toContain('forbidden');
      });

      it('fails fast with an actionable message when no cluster is configured', async () => {
        deploymentRepo.findOne.mockResolvedValue(baseDeployment);
        k8sControlPlane.isEnabled.mockReturnValue(false);

        const result = await service.deployToCloud('conv-1', 'user-1');

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/HOSTING_MODE=docker-run/);
        // Never waste a Docker build on a deploy that cannot land.
        expect(containerRegistryService.buildAndPush).not.toHaveBeenCalled();
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
        expect(containerRegistryService.buildAndPush).not.toHaveBeenCalled();
        expect(k8sControlPlane.applyServer).not.toHaveBeenCalled();
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

    it('stopServer uses LocalDockerHostingService for docker-run servers and never touches the cluster', async () => {
      hostedServerRepo.findOne.mockResolvedValue(dockerRunServer());

      await service.stopServer('srv-1');

      expect(localDockerHostingService.stopContainer).toHaveBeenCalledWith('srv-1');
      expect(k8sControlPlane.scaleServer).not.toHaveBeenCalled();
    });

    it('stopServer scales the Deployment to 0 for kubernetes-mode servers', async () => {
      hostedServerRepo.findOne.mockResolvedValue(k8sServer());

      await service.stopServer('srv-2');

      expect(k8sControlPlane.scaleServer).toHaveBeenCalledWith('srv-2', 0);
      expect(localDockerHostingService.stopContainer).not.toHaveBeenCalled();
    });

    it('stopServer records the users intent as desiredState=stopped', async () => {
      const srv = k8sServer();
      hostedServerRepo.findOne.mockResolvedValue(srv);

      await service.stopServer('srv-2');

      expect(srv.desiredState).toBe('stopped');
    });

    it('startServer scales back to 1 and reports deploying rather than asserting running', async () => {
      const srv = k8sServer({ status: 'stopped' });
      hostedServerRepo.findOne.mockResolvedValue(srv);

      await service.startServer('srv-2');

      expect(k8sControlPlane.scaleServer).toHaveBeenCalledWith('srv-2', 1);
      expect(srv.desiredState).toBe('running');
      expect(srv.status).toBe('deploying');
    });

    it('startServer rejects a server that is not stopped', async () => {
      hostedServerRepo.findOne.mockResolvedValue(dockerRunServer({ status: 'running' }));

      await expect(service.startServer('srv-1')).rejects.toThrow(BadRequestException);
    });

    it('startServer re-verifies the MCP handshake for docker-run servers', async () => {
      hostedServerRepo.findOne.mockResolvedValue(dockerRunServer({ status: 'stopped' }));
      localDockerHostingService.startAndVerify.mockResolvedValue({
        containerName: 'mcp-hosted-srv-1',
        handshake: { success: true, tools: [{ name: 'get_user' }] },
      });

      await service.startServer('srv-1');

      expect(localDockerHostingService.startAndVerify).toHaveBeenCalledWith(
        'srv-1',
        'mcp-local/srv-1:latest',
        {},
      );
    });

    it('deleteServer stops the container for docker-run servers instead of touching the cluster/registry', async () => {
      hostedServerRepo.findOne.mockResolvedValue(dockerRunServer());

      await service.deleteServer('srv-1');

      expect(localDockerHostingService.stopContainer).toHaveBeenCalledWith('srv-1');
      expect(k8sControlPlane.deleteServer).not.toHaveBeenCalled();
      expect(containerRegistryService.deleteImage).not.toHaveBeenCalled();
    });

    /**
     * Real deletion, not a removal commit. The GitOps path left every deleted
     * server - and anything in its manifests - recoverable in git history
     * forever, which is the wrong behaviour for account deletion.
     */
    it('deleteServer really deletes the cluster objects for kubernetes-mode servers', async () => {
      const srv = k8sServer();
      hostedServerRepo.findOne.mockResolvedValue(srv);

      await service.deleteServer('srv-2');

      expect(k8sControlPlane.deleteServer).toHaveBeenCalledWith('srv-2');
      expect(containerRegistryService.deleteImage).toHaveBeenCalledWith('srv-2');
      expect(srv.desiredState).toBe('deleted');
    });

    it('getServerLogs returns real docker logs for docker-run servers', async () => {
      hostedServerRepo.findOne.mockResolvedValue(dockerRunServer());
      localDockerHostingService.getLogs.mockResolvedValue(['line 1', 'line 2']);

      const result = await service.getServerLogs('srv-1', { lines: 50 });

      expect(result.logs).toEqual(['line 1', 'line 2']);
      expect(localDockerHostingService.getLogs).toHaveBeenCalledWith('srv-1', 50);
    });

    it('getServerLogs returns real pod logs for kubernetes-mode servers', async () => {
      hostedServerRepo.findOne.mockResolvedValue(k8sServer());
      k8sControlPlane.getLogs.mockResolvedValue(['pod line 1', 'pod line 2']);

      const result = await service.getServerLogs('srv-2', { lines: 25 });

      expect(k8sControlPlane.getLogs).toHaveBeenCalledWith('srv-2', 25);
      expect(result.logs).toEqual(['pod line 1', 'pod line 2']);
    });

    it('getServerLogs explains itself when no cluster is configured', async () => {
      hostedServerRepo.findOne.mockResolvedValue(k8sServer());
      k8sControlPlane.isEnabled.mockReturnValue(false);

      const result = await service.getServerLogs('srv-2', {});

      expect(result.logs).toEqual([]);
      expect(result.message).toMatch(/not configured/);
    });

    it('throws NotFoundException for a server that does not exist', async () => {
      hostedServerRepo.findOne.mockResolvedValue(null);

      await expect(service.stopServer('missing')).rejects.toThrow(NotFoundException);
    });
  });
});
