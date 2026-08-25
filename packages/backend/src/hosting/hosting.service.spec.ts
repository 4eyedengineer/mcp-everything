import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { HostingService } from './hosting.service';
import { UserService } from '../user/user.service';
import { TokenEncryptionService } from '../common/token-encryption/token-encryption.service';
import { HostedServerSourceTokenService } from './hosted-server-source-token.service';
import { HostedMcpClientService } from './services/hosted-mcp-client.service';
import { UserTier } from '../subscription/tier-config';
import { HostedServer } from '../database/entities/hosted-server.entity';
import { Conversation } from '../database/entities/conversation.entity';
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
    increment: jest.Mock;
    update: jest.Mock;
  };
  let userService: { findById: jest.Mock };
  let conversationRepo: { findOne: jest.Mock };
  let tokenEncryptionService: { enabled: boolean; encrypt: jest.Mock; decrypt: jest.Mock };
  let sourceTokenService: { mintToken: jest.Mock; revokeAllForServer: jest.Mock };
  let containerRegistryService: {
    buildAndPush: jest.Mock;
    buildImage: jest.Mock;
    pushImage: jest.Mock;
    deleteImage: jest.Mock;
  };
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
      // Pinned so 'copies localPath onto the hosted server' can assert on an
      // exact value instead of one derived from process.cwd() at test time.
      if (key === 'GENERATED_SERVERS_DIR') return '/generated-servers';
      return defaultValue;
    }),
  };

  // What a real chat generation persists onto the conversation row - see
  // GenerationPipeline.syncGeneratedCodeToConversation. deployToCloud reads
  // server metadata from here, not from a `deployments` row (that table is
  // empty in production; nothing in the generation path ever writes to it).
  const baseConversation = {
    id: 'conv-1',
    userId: 'user-1',
    state: {
      metadata: { title: 'A generated server' },
      tools: [{ name: 'get_user', description: 'Fetch a user', inputSchema: {} }],
      generatedCode: {
        mainFile: '// ...',
        supportingFiles: {},
        metadata: {
          serverName: 'github-api-mcp',
          tools: [{ name: 'get_user', description: 'Fetch a user', inputSchema: {} }],
          iteration: 1,
        },
      },
    },
  } as unknown as Conversation;

  beforeEach(async () => {
    jest.clearAllMocks();
    hostingMode = 'kubernetes';

    hostedServerRepo = {
      create: jest.fn((data) => ({ ...data })),
      save: jest.fn(async (entity) => entity),
      findOne: jest.fn(),
      // Quota counting: default to "no servers yet" so existing tests deploy.
      count: jest.fn().mockResolvedValue(0),
      increment: jest.fn().mockResolvedValue({ affected: 1 }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn(),
    };
    userService = {
      findById: jest.fn().mockResolvedValue({ id: 'user-1', tier: UserTier.FREE }),
    };
    conversationRepo = { findOne: jest.fn() };
    /**
     * A real-behaviour fake rather than a pass-through: encrypt/decrypt must
     * actually round-trip (and must be able to fail, via `enabled = false`,
     * mirroring "no TOKEN_ENCRYPTION_KEY configured") for the restart-env
     * regression tests to mean anything. AES key management itself is
     * TokenEncryptionService's own tested concern, not HostingService's.
     */
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
    containerRegistryService = {
      buildAndPush: jest.fn(),
      // buildImage/pushImage are the real deploy path now - they were split
      // apart so the 'pushing' status the UI renders can actually be reached.
      buildImage: jest.fn().mockResolvedValue('ghcr.io/owner/repo/x:latest'),
      pushImage: jest.fn().mockResolvedValue(undefined),
      deleteImage: jest.fn(),
    };
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

    sourceTokenService = {
      mintToken: jest.fn().mockResolvedValue({
        token: 'mcpsrc_test-token',
        id: 'source-token-1',
        tokenPrefix: 'mcpsrc_abcdef',
        expiresAt: new Date('2026-09-01T00:00:00.000Z'),
      }),
      revokeAllForServer: jest.fn().mockResolvedValue(0),
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
        { provide: getRepositoryToken(Conversation), useValue: conversationRepo },
        { provide: ContainerRegistryService, useValue: containerRegistryService },
        { provide: ManifestGeneratorService, useValue: manifestGeneratorService },
        { provide: K8sControlPlaneService, useValue: k8sControlPlane },
        { provide: LocalDockerHostingService, useValue: localDockerHostingService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: UserService, useValue: userService },
        { provide: TokenEncryptionService, useValue: tokenEncryptionService },
        { provide: HostedServerSourceTokenService, useValue: sourceTokenService },
        {
          provide: HostedMcpClientService,
          useValue: { invalidate: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    return module.get<HostingService>(HostingService);
  }

  describe('deployToCloud', () => {
    it('throws NotFoundException when no conversation exists for the id', async () => {
      conversationRepo.findOne.mockResolvedValue(null);

      await expect(service.deployToCloud('conv-1', 'user-1')).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when the conversation is not owned by the caller', async () => {
      // Scoped lookup (id + userId) - a real repo would return null for a
      // conversation that exists but belongs to someone else.
      conversationRepo.findOne.mockResolvedValue(null);

      await expect(service.deployToCloud('conv-1', 'someone-else')).rejects.toThrow(
        NotFoundException,
      );
      expect(conversationRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'conv-1', userId: 'someone-else' } }),
      );
    });

    it('throws BadRequestException when the conversation has not generated a server yet', async () => {
      conversationRepo.findOne.mockResolvedValue({ ...baseConversation, state: {} });

      await expect(service.deployToCloud('conv-1', 'user-1')).rejects.toThrow(BadRequestException);
    });

    it('deploys using the conversations own serverName/tools when generatedCode is present', async () => {
      conversationRepo.findOne.mockResolvedValue(baseConversation);

      const result = await service.deployToCloud('conv-1', 'user-1');

      expect(result.success).toBe(true);
      expect(hostedServerRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          serverName: 'github-api-mcp',
          tools: [{ name: 'get_user', description: 'Fetch a user', inputSchema: {} }],
        }),
      );
    });

    describe('per-user concurrent hosted-server cap', () => {
      beforeEach(() => {
        conversationRepo.findOne.mockResolvedValue(baseConversation);
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

      it('blocks before doing any expensive work (no token minted, no cluster apply, no row written)', async () => {
        hostedServerRepo.count.mockResolvedValue(1);

        await expect(service.deployToCloud('conv-1', 'user-1')).rejects.toThrow(ForbiddenException);

        expect(hostedServerRepo.save).not.toHaveBeenCalled();
        expect(sourceTokenService.mintToken).not.toHaveBeenCalled();
        expect(k8sControlPlane.applyServer).not.toHaveBeenCalled();
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
      conversationRepo.findOne.mockResolvedValue(baseConversation);

      // Run many times since the suffix is random - regression guard for the
      // nanoid-default-alphabet bug (suffix could end in '-' or '_').
      for (let i = 0; i < 25; i++) {
        const result = await service.deployToCloud('conv-1', 'user-1');
        expect(result.serverId).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
        expect(result.serverId).not.toMatch(/[-_]$/);
      }
    });

    describe('kubernetes mode (default)', () => {
      it('applies the server to the cluster without building or pushing any image', async () => {
        conversationRepo.findOne.mockResolvedValue(baseConversation);

        const result = await service.deployToCloud('conv-1', 'user-1');

        expect(result.success).toBe(true);
        // Every hosting mode now advertises the gateway URL, not a per-server
        // subdomain - nothing ever served `https://<serverId>.<domain>` because
        // ManifestGeneratorService creates no Ingress.
        expect(result.endpointUrl).toBe(
          `http://localhost:3000/api/hosting/servers/${result.serverId}/mcp`,
        );
        expect(k8sControlPlane.applyServer).toHaveBeenCalledWith(
          expect.objectContaining({ serverId: result.serverId, replicas: 1 }),
        );
        expect(localDockerHostingService.buildImage).not.toHaveBeenCalled();
      });

      /**
       * The load-bearing assertion of the whole change. The backend runs as a
       * pod with no docker binary and no docker socket, so ANY docker call on
       * this path is unreachable code that fails every Kubernetes deploy. The
       * build moved into the deployed pod's initContainer.
       */
      it('never invokes the container registry at all', async () => {
        conversationRepo.findOne.mockResolvedValue(baseConversation);

        await service.deployToCloud('conv-1', 'user-1');

        expect(containerRegistryService.buildImage).not.toHaveBeenCalled();
        expect(containerRegistryService.pushImage).not.toHaveBeenCalled();
        expect(containerRegistryService.buildAndPush).not.toHaveBeenCalled();
      });

      /** No image is built, so no image reference belongs to this server. */
      it('passes no per-server image to the control plane and records none', async () => {
        conversationRepo.findOne.mockResolvedValue(baseConversation);

        await service.deployToCloud('conv-1', 'user-1');

        const spec = k8sControlPlane.applyServer.mock.calls[0][0];
        expect(spec.dockerImage).toBeUndefined();

        const savedCalls = hostedServerRepo.save.mock.calls.map((c) => c[0]);
        expect(savedCalls[savedCalls.length - 1].dockerImage).toBe('');
      });

      /**
       * GENERATED_SERVERS_DIR is an emptyDir on the backend pod, so it is
       * empty for anything generated before the last restart. The Kubernetes
       * path reads the source from Postgres via the pod's own fetch, so it
       * never reads the (always-computed) local directory at all. docker-run,
       * which really does build from disk, is the one that cares.
       */
      it('does not require a local source directory', async () => {
        conversationRepo.findOne.mockResolvedValue(baseConversation);

        const result = await service.deployToCloud('conv-1', 'user-1');

        expect(result.success).toBe(true);
        expect(result.status).toBe('deploying');
        expect(k8sControlPlane.applyServer).toHaveBeenCalled();
      });

      /**
       * The conversation row is only SET NULL on HostedServer, so the source
       * path has to be copied onto the hosted server (deterministically, from
       * GENERATED_SERVERS_DIR + conversationId - see the constructor) or
       * deleting the chat leaves a live, unrebuildable server.
       */
      it('copies a deterministic localPath onto the hosted server', async () => {
        conversationRepo.findOne.mockResolvedValue(baseConversation);

        await service.deployToCloud('conv-1', 'user-1');

        expect(hostedServerRepo.create).toHaveBeenCalledWith(
          expect.objectContaining({ localPath: '/generated-servers/conv-1' }),
        );
      });

      /**
       * There is no backend-side build or push any more, so neither status can
       * honestly be reported here - and a status the UI renders that nothing
       * sets is the exact bug this repo already shipped once with 'pushing'.
       * The deploy-progress UI was narrowed to pending -> deploying -> running
       * to match; this is the backend half of that contract.
       */
      it('reports only pending -> deploying, never building or pushing', async () => {
        conversationRepo.findOne.mockResolvedValue(baseConversation);

        // save() is handed the same mutated entity every time, so the status
        // has to be snapshotted at call time rather than read back off
        // save.mock.calls afterwards.
        const statuses: string[] = [];
        hostedServerRepo.save.mockImplementation(async (entity: { status: string }) => {
          statuses.push(entity.status);
          return entity;
        });

        await service.deployToCloud('conv-1', 'user-1');

        expect(statuses).not.toContain('building');
        expect(statuses).not.toContain('pushing');
        expect(statuses[0]).toBe('pending');
        expect(statuses).toContain('deploying');
      });

      /**
       * Regression guard for the central bug: the old code wrote 'running' the
       * moment a GitOps commit succeeded, so a pod that never started reported
       * 'running' forever. Applying objects to the API server proves only that
       * the cluster ACCEPTED them - readiness is the reconciler's call.
       */
      it('reports deploying, NOT running - readiness is the reconcilers job', async () => {
        conversationRepo.findOne.mockResolvedValue(baseConversation);

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
        conversationRepo.findOne.mockResolvedValue(baseConversation);

        await service.deployToCloud('conv-1', 'user-1', { GITHUB_TOKEN: 'ghp_secret' });

        expect(k8sControlPlane.applyServer).toHaveBeenCalledWith(
          expect.objectContaining({
            envVars: expect.objectContaining({ GITHUB_TOKEN: 'ghp_secret' }),
          }),
        );
      });

      /**
       * The pod cannot read the backend pod's GENERATED_SERVERS_DIR emptyDir,
       * so it fetches its own source over HTTP - which needs a URL and a
       * credential. They ride in on the same envVars that already become a
       * Kubernetes Secret, which is why this needs no change to
       * ManifestGeneratorService or K8sControlPlaneService.
       */
      it('injects the source URL and a minted source token into the pod env', async () => {
        conversationRepo.findOne.mockResolvedValue(baseConversation);

        const result = await service.deployToCloud('conv-1', 'user-1');

        expect(sourceTokenService.mintToken).toHaveBeenCalledTimes(1);
        expect(k8sControlPlane.applyServer).toHaveBeenCalledWith(
          expect.objectContaining({
            envVars: expect.objectContaining({
              MCP_SOURCE_URL: `http://localhost:3000/api/hosting/servers/${result.serverId}/source`,
              MCP_SOURCE_TOKEN: 'mcpsrc_test-token',
            }),
          }),
        );
      });

      /**
       * The token plaintext must never leave the deploy path. Only its
       * non-secret identity and expiry are reported, so an operator can
       * correlate a pod's 401s with a specific credential.
       */
      it('reports the source token identity but never the token itself', async () => {
        conversationRepo.findOne.mockResolvedValue(baseConversation);

        const result = await service.deployToCloud('conv-1', 'user-1');

        expect(result.sourceTokenId).toBe('source-token-1');
        expect(result.sourceTokenExpiresAt).toEqual(new Date('2026-09-01T00:00:00.000Z'));
        expect(JSON.stringify(result)).not.toContain('mcpsrc_test-token');
      });

      it('records where the objects live so the reconciler can find them', async () => {
        conversationRepo.findOne.mockResolvedValue(baseConversation);

        const result = await service.deployToCloud('conv-1', 'user-1');

        const savedCalls = hostedServerRepo.save.mock.calls.map((c) => c[0]);
        const finalSave = savedCalls[savedCalls.length - 1];
        expect(finalSave.k8sDeploymentName).toBe(`mcp-${result.serverId}`);
        expect(finalSave.deployedAt).toBeInstanceOf(Date);
      });

      it('reports failed when the cluster rejects the objects', async () => {
        conversationRepo.findOne.mockResolvedValue(baseConversation);
        k8sControlPlane.applyServer.mockRejectedValue(
          new Error('HTTP 403: deployments.apps is forbidden'),
        );

        const result = await service.deployToCloud('conv-1', 'user-1');

        expect(result.success).toBe(false);
        expect(result.status).toBe('failed');
        expect(result.error).toContain('forbidden');
      });

      it('fails fast with an actionable message when no cluster is configured', async () => {
        conversationRepo.findOne.mockResolvedValue(baseConversation);
        k8sControlPlane.isEnabled.mockReturnValue(false);

        const result = await service.deployToCloud('conv-1', 'user-1');

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/HOSTING_MODE=docker-run/);
        expect(k8sControlPlane.applyServer).not.toHaveBeenCalled();
      });
    });

    describe('docker-run mode', () => {
      beforeEach(async () => {
        hostingMode = 'docker-run';
        service = await buildService();
      });

      it('builds locally, starts+verifies the container, and reports running with handshake evidence in config', async () => {
        conversationRepo.findOne.mockResolvedValue(baseConversation);
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
        // Even a stdio docker-run server advertises the gateway URL. It will
        // be rejected with a specific 503 by McpUpstreamResolver rather than
        // advertising the `docker-exec://` pseudo-URL it used to.
        expect(result.endpointUrl).toBe(
          `http://localhost:3000/api/hosting/servers/${result.serverId}/mcp`,
        );
        expect(containerRegistryService.buildAndPush).not.toHaveBeenCalled();
        expect(k8sControlPlane.applyServer).not.toHaveBeenCalled();
        expect(localDockerHostingService.startAndVerify).toHaveBeenCalledWith(
          result.serverId,
          'mcp-local/x:latest',
          expect.objectContaining({ GITHUB_TOKEN: 'abc' }),
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

      it('advertises the gateway URL (not the loopback port) for an HTTP-transport server', async () => {
        conversationRepo.findOne.mockResolvedValue(baseConversation);
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
        // The loopback port is an internal upstream detail now; it is
        // recomputed by McpUpstreamResolver and never published.
        expect(result.endpointUrl).toBe(
          `http://localhost:3000/api/hosting/servers/${result.serverId}/mcp`,
        );
        expect(result.endpointUrl).not.toMatch(/localhost:2\d{4}/);

        const savedCalls = hostedServerRepo.save.mock.calls.map((c) => c[0]);
        const finalSave = savedCalls[savedCalls.length - 1];
        expect(finalSave.statusMessage).toContain('Verified via http MCP handshake');
      });

      it('reports failed with the real handshake error when the container never becomes a working MCP server', async () => {
        conversationRepo.findOne.mockResolvedValue(baseConversation);
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
        conversationRepo.findOne.mockResolvedValue(baseConversation);
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

    /**
     * Defect: startServer passed `{}` for env vars. LocalDockerHostingService
     * defaults MCP_TRANSPORT to stdio when it is absent, and stdio publishes
     * no port - so a stopped-then-started HTTP server came back up
     * unreachable at the http://localhost:<port> endpointUrl its own row
     * still advertises, and any user-supplied API keys were silently dropped.
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
      conversationRepo.findOne.mockResolvedValue(baseConversation);
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
      // The source token is part of the deploy env and is therefore persisted
      // here too - encrypted, like every other secret. That is deliberate: a
      // `startServer` restart replays this env, and the pod must still be able
      // to fetch its source. See HostedServerSourceTokenService on why the
      // token is reusable rather than single-use.
      expect(saved.deployEnvEncrypted).toBe(
        'enc({"MCP_TRANSPORT":"http","API_KEY":"sk-secret",' +
          `"MCP_SOURCE_URL":"http://localhost:3000/api/hosting/servers/${saved.serverId}/source",` +
          '"MCP_SOURCE_TOKEN":"mcpsrc_test-token"})',
      );
      expect(JSON.stringify(saved.config)).not.toContain('sk-secret');
      // The token must never reach the cleartext config column.
      expect(JSON.stringify(saved.config)).not.toContain('mcpsrc_test-token');
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
      // Nothing to delete from a registry: Kubernetes-hosted servers own no
      // image, they all run the shared runner.
      expect(containerRegistryService.deleteImage).not.toHaveBeenCalled();
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

  /**
   * trackRequest is the gateway's usage hook, and the gateway calls it on every
   * MCP message. These tests pin the batching behaviour, because the naive
   * write-through version issued two row-locking writes per request.
   */
  describe('trackRequest / flushRequestCounts', () => {
    it('does not touch the database until flushed', async () => {
      await service.trackRequest('srv-1');
      await service.trackRequest('srv-1');

      expect(hostedServerRepo.increment).not.toHaveBeenCalled();
      expect(hostedServerRepo.update).not.toHaveBeenCalled();
    });

    it('collapses many requests for one server into a single increment', async () => {
      for (let i = 0; i < 25; i++) {
        await service.trackRequest('srv-1');
      }

      await service.flushRequestCounts();

      expect(hostedServerRepo.increment).toHaveBeenCalledTimes(1);
      expect(hostedServerRepo.increment).toHaveBeenCalledWith(
        { serverId: 'srv-1' },
        'requestCount',
        25,
      );
      expect(hostedServerRepo.update).toHaveBeenCalledTimes(1);
      expect(hostedServerRepo.update).toHaveBeenCalledWith(
        { serverId: 'srv-1' },
        { lastRequestAt: expect.any(Date) },
      );
    });

    it('keeps per-server counts separate', async () => {
      await service.trackRequest('srv-1');
      await service.trackRequest('srv-2');
      await service.trackRequest('srv-1');

      await service.flushRequestCounts();

      expect(hostedServerRepo.increment).toHaveBeenCalledWith(
        { serverId: 'srv-1' },
        'requestCount',
        2,
      );
      expect(hostedServerRepo.increment).toHaveBeenCalledWith(
        { serverId: 'srv-2' },
        'requestCount',
        1,
      );
    });

    it('empties the buffer, so a second flush is a no-op', async () => {
      await service.trackRequest('srv-1');
      await service.flushRequestCounts();
      hostedServerRepo.increment.mockClear();

      await service.flushRequestCounts();

      expect(hostedServerRepo.increment).not.toHaveBeenCalled();
    });

    it('never lets a database failure escape into the request path', async () => {
      hostedServerRepo.increment.mockRejectedValueOnce(new Error('deadlock detected'));
      await service.trackRequest('srv-1');

      await expect(service.flushRequestCounts()).resolves.toBeUndefined();
    });

    it('flushes on orderly shutdown so a normal restart loses nothing', async () => {
      await service.trackRequest('srv-1');

      await service.onModuleDestroy();

      expect(hostedServerRepo.increment).toHaveBeenCalledWith(
        { serverId: 'srv-1' },
        'requestCount',
        1,
      );
    });
  });

  describe('gatewayUrlFor', () => {
    it('builds a path-addressed URL on one origin, not a per-server subdomain', () => {
      expect(service.gatewayUrlFor('stripe-abc123k9')).toBe(
        'http://localhost:3000/api/hosting/servers/stripe-abc123k9/mcp',
      );
    });
  });

});
