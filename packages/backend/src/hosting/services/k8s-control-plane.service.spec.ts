import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { V1Deployment, V1Pod } from '@kubernetes/client-node';
import { K8sControlPlaneService } from './k8s-control-plane.service';
import { ManifestGeneratorService } from './manifest-generator.service';

/**
 * These tests never touch a cluster. The two generated API clients are
 * replaced wholesale with jest mocks, so what is verified is exactly the part
 * that is ours: which objects we build, which calls we make with them, and how
 * we interpret what comes back.
 */
describe('K8sControlPlaneService', () => {
  let service: K8sControlPlaneService;
  let appsApi: {
    patchNamespacedDeployment: jest.Mock;
    deleteNamespacedDeployment: jest.Mock;
    readNamespacedDeployment: jest.Mock;
    listNamespacedDeployment: jest.Mock;
  };
  let coreApi: {
    patchNamespacedSecret: jest.Mock;
    patchNamespacedService: jest.Mock;
    deleteNamespacedService: jest.Mock;
    deleteNamespacedSecret: jest.Mock;
    listNamespacedPod: jest.Mock;
    readNamespacedPodLog: jest.Mock;
  };

  const config = { serverId: 'stripe-abc123', serverName: 'stripe-mcp' };

  /** Minimal stand-in for the client's HttpError (statusCode + message). */
  function apiError(statusCode: number): Error & { statusCode: number } {
    return Object.assign(new Error(`HTTP ${statusCode}`), { statusCode });
  }

  function deploymentFixture(overrides: {
    replicas?: number;
    readyReplicas?: number;
    serverId?: string;
  } = {}): V1Deployment {
    return {
      metadata: {
        name: `mcp-${overrides.serverId ?? config.serverId}`,
        labels: { app: 'mcp-server', 'server-id': overrides.serverId ?? config.serverId },
      },
      spec: { replicas: overrides.replicas ?? 1, selector: {}, template: {} },
      status: { readyReplicas: overrides.readyReplicas ?? 0 },
    };
  }

  function podWithWaitingReason(reason: string, message: string, serverId = config.serverId): V1Pod {
    return {
      metadata: { name: 'pod-1', labels: { app: 'mcp-server', 'server-id': serverId } },
      status: {
        phase: 'Pending',
        containerStatuses: [
          {
            name: 'mcp-server',
            image: 'x',
            imageID: '',
            ready: false,
            restartCount: 0,
            state: { waiting: { reason, message } },
          },
        ],
      },
    };
  }

  beforeEach(async () => {
    appsApi = {
      patchNamespacedDeployment: jest.fn().mockResolvedValue({}),
      deleteNamespacedDeployment: jest.fn().mockResolvedValue({}),
      readNamespacedDeployment: jest.fn(),
      listNamespacedDeployment: jest.fn().mockResolvedValue({ body: { items: [] } }),
    };
    coreApi = {
      patchNamespacedSecret: jest.fn().mockResolvedValue({}),
      patchNamespacedService: jest.fn().mockResolvedValue({}),
      deleteNamespacedService: jest.fn().mockResolvedValue({}),
      deleteNamespacedSecret: jest.fn().mockResolvedValue({}),
      listNamespacedPod: jest.fn().mockResolvedValue({ body: { items: [] } }),
      readNamespacedPodLog: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        K8sControlPlaneService,
        ManifestGeneratorService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: unknown) => {
              if (key === 'K8S_NAMESPACE') return 'mcp-servers';
              return defaultValue;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<K8sControlPlaneService>(K8sControlPlaneService);
    // Swap in the mocked clients regardless of whether the host running these
    // tests happens to have a kubeconfig.
    (service as unknown as { appsApi: unknown }).appsApi = appsApi;
    (service as unknown as { coreApi: unknown }).coreApi = coreApi;
  });

  describe('applyServer', () => {
    it('creates a Deployment and a Service for a server with no env vars, and no Secret', async () => {
      await service.applyServer({ ...config, dockerImage: 'ghcr.io/o/r/x:latest' });

      expect(coreApi.patchNamespacedSecret).not.toHaveBeenCalled();

      expect(appsApi.patchNamespacedDeployment).toHaveBeenCalledTimes(1);
      const [deploymentName, deploymentNs, deploymentBody] =
        appsApi.patchNamespacedDeployment.mock.calls[0];
      expect(deploymentName).toBe('mcp-stripe-abc123');
      expect(deploymentNs).toBe('mcp-servers');
      expect(deploymentBody.kind).toBe('Deployment');
      expect(deploymentBody.spec.replicas).toBe(1);

      expect(coreApi.patchNamespacedService).toHaveBeenCalledTimes(1);
      const [, , serviceBody] = coreApi.patchNamespacedService.mock.calls[0];
      expect(serviceBody.kind).toBe('Service');
      expect(serviceBody.spec.type).toBe('ClusterIP');
    });

    it('never creates an Ingress', async () => {
      await service.applyServer({ ...config, dockerImage: 'ghcr.io/o/r/x:latest' });

      const allCalls = [
        ...appsApi.patchNamespacedDeployment.mock.calls,
        ...coreApi.patchNamespacedService.mock.calls,
        ...coreApi.patchNamespacedSecret.mock.calls,
      ];
      for (const call of allCalls) {
        expect(call[2].kind).not.toBe('Ingress');
      }
    });

    describe('with user-supplied env vars', () => {
      const envVars = { STRIPE_API_KEY: 'sk_live_supersecret', REGION: 'eu' };

      it('writes them to a Secret', async () => {
        await service.applyServer({ ...config, dockerImage: 'ghcr.io/o/r/x:latest', envVars });

        expect(coreApi.patchNamespacedSecret).toHaveBeenCalledTimes(1);
        const [secretName, secretNs, secretBody] = coreApi.patchNamespacedSecret.mock.calls[0];
        expect(secretName).toBe('mcp-stripe-abc123-env');
        expect(secretNs).toBe('mcp-servers');
        expect(secretBody.stringData).toEqual(envVars);
      });

      it('does NOT put them in the Deployment as literal values', async () => {
        await service.applyServer({ ...config, dockerImage: 'ghcr.io/o/r/x:latest', envVars });

        const deploymentBody = appsApi.patchNamespacedDeployment.mock.calls[0][2];
        const serialized = JSON.stringify(deploymentBody);

        expect(serialized).not.toContain('sk_live_supersecret');
        expect(serialized).toContain('mcp-stripe-abc123-env');

        const container = deploymentBody.spec.template.spec.containers[0];
        expect(container.env.map((e: { name: string }) => e.name)).not.toContain('STRIPE_API_KEY');
        expect(container.envFrom[0].secretRef.name).toBe('mcp-stripe-abc123-env');
      });

      it('creates the Secret before the Deployment that references it', async () => {
        await service.applyServer({ ...config, dockerImage: 'ghcr.io/o/r/x:latest', envVars });

        const secretOrder = coreApi.patchNamespacedSecret.mock.invocationCallOrder[0];
        const deploymentOrder = appsApi.patchNamespacedDeployment.mock.invocationCallOrder[0];
        expect(secretOrder).toBeLessThan(deploymentOrder);
      });
    });

    it('uses server-side apply with a field manager, so concurrent deploys do not conflict', async () => {
      await service.applyServer({ ...config, dockerImage: 'ghcr.io/o/r/x:latest' });

      const call = appsApi.patchNamespacedDeployment.mock.calls[0];
      expect(call[5]).toBe('mcp-everything-control-plane'); // fieldManager
      expect(call[7]).toBe(true); // force
      expect(call[8].headers['Content-Type']).toBe('application/apply-patch+yaml');
    });
  });

  describe('scaleServer', () => {
    it('merge-patches spec.replicas', async () => {
      await service.scaleServer('stripe-abc123', 0);

      const call = appsApi.patchNamespacedDeployment.mock.calls[0];
      expect(call[0]).toBe('mcp-stripe-abc123');
      expect(call[1]).toBe('mcp-servers');
      expect(call[2]).toEqual({ spec: { replicas: 0 } });
      expect(call[8].headers['Content-Type']).toBe('application/merge-patch+json');
    });
  });

  describe('deleteServer', () => {
    it('deletes the Deployment, Service and Secret', async () => {
      await service.deleteServer('stripe-abc123');

      const deleteCall = appsApi.deleteNamespacedDeployment.mock.calls[0];
      expect(deleteCall[0]).toBe('mcp-stripe-abc123');
      expect(deleteCall[1]).toBe('mcp-servers');
      // Without an explicit policy the ReplicaSet (and its pods) can be
      // orphaned and keep running after a "delete".
      expect(deleteCall[6]).toBe('Background'); // propagationPolicy

      expect(coreApi.deleteNamespacedService).toHaveBeenCalledWith(
        'mcp-stripe-abc123',
        'mcp-servers',
      );
      expect(coreApi.deleteNamespacedSecret).toHaveBeenCalledWith(
        'mcp-stripe-abc123-env',
        'mcp-servers',
      );
    });

    it('is idempotent - a 404 on any object is the desired end state', async () => {
      appsApi.deleteNamespacedDeployment.mockRejectedValue(apiError(404));
      coreApi.deleteNamespacedService.mockRejectedValue(apiError(404));
      coreApi.deleteNamespacedSecret.mockRejectedValue(apiError(404));

      await expect(service.deleteServer('stripe-abc123')).resolves.toBeUndefined();
    });

    it('propagates a real failure (e.g. 403 from RBAC) rather than swallowing it', async () => {
      appsApi.deleteNamespacedDeployment.mockRejectedValue(apiError(403));

      await expect(service.deleteServer('stripe-abc123')).rejects.toThrow('HTTP 403');
    });
  });

  describe('deriveObservedState', () => {
    it('reports running when all replicas are ready', () => {
      const state = service.deriveObservedState(
        config.serverId,
        deploymentFixture({ replicas: 1, readyReplicas: 1 }),
        [],
      );

      expect(state.status).toBe('running');
      expect(state.replicas).toBe(1);
      expect(state.readyReplicas).toBe(1);
    });

    it('reports stopped when scaled to zero', () => {
      const state = service.deriveObservedState(
        config.serverId,
        deploymentFixture({ replicas: 0, readyReplicas: 0 }),
        [],
      );

      expect(state.status).toBe('stopped');
      expect(state.replicas).toBe(0);
    });

    it('reports failed with the reason for CrashLoopBackOff', () => {
      const state = service.deriveObservedState(
        config.serverId,
        deploymentFixture({ replicas: 1, readyReplicas: 0 }),
        [podWithWaitingReason('CrashLoopBackOff', 'back-off 5m0s restarting failed container')],
      );

      expect(state.status).toBe('failed');
      expect(state.message).toContain('CrashLoopBackOff');
      expect(state.message).toContain('back-off 5m0s');
      expect(state.readyReplicas).toBe(0);
    });

    it('reports failed with the reason for ImagePullBackOff', () => {
      const state = service.deriveObservedState(
        config.serverId,
        deploymentFixture({ replicas: 1, readyReplicas: 0 }),
        [podWithWaitingReason('ImagePullBackOff', 'Back-off pulling image "ghcr.io/o/r/x:latest"')],
      );

      expect(state.status).toBe('failed');
      expect(state.message).toContain('ImagePullBackOff');
      expect(state.message).toContain('ghcr.io/o/r/x:latest');
    });

    it('reports failed for OOMKilled even when the container has already restarted', () => {
      const pod: V1Pod = {
        metadata: { name: 'pod-1', labels: { 'server-id': config.serverId } },
        status: {
          phase: 'Running',
          containerStatuses: [
            {
              name: 'mcp-server',
              image: 'x',
              imageID: '',
              ready: false,
              restartCount: 3,
              state: { running: { startedAt: new Date() } },
              lastState: { terminated: { reason: 'OOMKilled', exitCode: 137 } },
            },
          ],
        },
      };

      const state = service.deriveObservedState(
        config.serverId,
        deploymentFixture({ replicas: 1, readyReplicas: 0 }),
        [pod],
      );

      expect(state.status).toBe('failed');
      expect(state.message).toContain('OOMKilled');
      expect(state.message).toContain('restartCount=3');
    });

    it('a fatal pod reason beats "still progressing"', () => {
      // 1 desired, 0 ready would otherwise look like a normal rollout.
      const state = service.deriveObservedState(
        config.serverId,
        deploymentFixture({ replicas: 1, readyReplicas: 0 }),
        [podWithWaitingReason('CrashLoopBackOff', 'crashing')],
      );

      expect(state.status).toBe('failed');
      expect(state.status).not.toBe('progressing');
    });

    it('reports progressing (not failed) for a benign waiting reason', () => {
      const state = service.deriveObservedState(
        config.serverId,
        deploymentFixture({ replicas: 1, readyReplicas: 0 }),
        [podWithWaitingReason('ContainerCreating', 'creating container')],
      );

      expect(state.status).toBe('progressing');
      expect(state.message).toContain('ContainerCreating');
    });

    it('reports degraded when only some replicas are ready', () => {
      const state = service.deriveObservedState(
        config.serverId,
        deploymentFixture({ replicas: 3, readyReplicas: 1 }),
        [],
      );

      expect(state.status).toBe('degraded');
      expect(state.readyReplicas).toBe(1);
      expect(state.replicas).toBe(3);
    });

    it('reports failed for a pod in the Failed phase', () => {
      const pod: V1Pod = {
        metadata: { name: 'pod-1', labels: { 'server-id': config.serverId } },
        status: { phase: 'Failed', reason: 'Evicted', message: 'The node was low on ephemeral storage' },
      };

      const state = service.deriveObservedState(
        config.serverId,
        deploymentFixture({ replicas: 1, readyReplicas: 0 }),
        [pod],
      );

      expect(state.status).toBe('failed');
      expect(state.message).toContain('Evicted');
    });
  });

  describe('getObservedState', () => {
    it('reports missing when the Deployment does not exist', async () => {
      appsApi.readNamespacedDeployment.mockRejectedValue(apiError(404));

      const state = await service.getObservedState('stripe-abc123');

      expect(state.status).toBe('missing');
      expect(state.replicas).toBe(0);
    });

    it('reports unknown (not failed) when the cluster cannot be reached', async () => {
      appsApi.readNamespacedDeployment.mockRejectedValue(new Error('ECONNREFUSED'));

      const state = await service.getObservedState('stripe-abc123');

      expect(state.status).toBe('unknown');
      expect(state.message).toContain('ECONNREFUSED');
    });

    it('combines the Deployment with its pods', async () => {
      appsApi.readNamespacedDeployment.mockResolvedValue({
        body: deploymentFixture({ replicas: 1, readyReplicas: 0 }),
      });
      coreApi.listNamespacedPod.mockResolvedValue({
        body: { items: [podWithWaitingReason('ImagePullBackOff', 'no such image')] },
      });

      const state = await service.getObservedState('stripe-abc123');

      expect(coreApi.listNamespacedPod).toHaveBeenCalledWith(
        'mcp-servers',
        undefined,
        undefined,
        undefined,
        undefined,
        'server-id=stripe-abc123',
      );
      expect(state.status).toBe('failed');
    });
  });

  describe('observeAll', () => {
    it('observes every server in two list calls, keyed by serverId', async () => {
      appsApi.listNamespacedDeployment.mockResolvedValue({
        body: {
          items: [
            deploymentFixture({ serverId: 'srv-a', replicas: 1, readyReplicas: 1 }),
            deploymentFixture({ serverId: 'srv-b', replicas: 1, readyReplicas: 0 }),
          ],
        },
      });
      coreApi.listNamespacedPod.mockResolvedValue({
        body: { items: [podWithWaitingReason('CrashLoopBackOff', 'boom', 'srv-b')] },
      });

      const states = await service.observeAll();

      expect(appsApi.listNamespacedDeployment).toHaveBeenCalledTimes(1);
      expect(coreApi.listNamespacedPod).toHaveBeenCalledTimes(1);
      expect(states.get('srv-a')?.status).toBe('running');
      expect(states.get('srv-b')?.status).toBe('failed');
      expect(states.get('srv-b')?.message).toContain('CrashLoopBackOff');
    });

    it('filters both lists by the mcp-server app label', async () => {
      appsApi.listNamespacedDeployment.mockResolvedValue({ body: { items: [] } });

      await service.observeAll();

      const LABEL_SELECTOR_ARG = 5;
      expect(appsApi.listNamespacedDeployment.mock.calls[0][0]).toBe('mcp-servers');
      expect(appsApi.listNamespacedDeployment.mock.calls[0][LABEL_SELECTOR_ARG]).toBe(
        'app=mcp-server',
      );
      expect(coreApi.listNamespacedPod.mock.calls[0][0]).toBe('mcp-servers');
      expect(coreApi.listNamespacedPod.mock.calls[0][LABEL_SELECTOR_ARG]).toBe('app=mcp-server');
    });
  });

  describe('getLogs', () => {
    it('tails the newest pod', async () => {
      coreApi.listNamespacedPod.mockResolvedValue({
        body: {
          items: [
            { metadata: { name: 'old-pod', creationTimestamp: new Date('2026-01-01T00:00:00Z') } },
            { metadata: { name: 'new-pod', creationTimestamp: new Date('2026-06-01T00:00:00Z') } },
          ],
        },
      });
      coreApi.readNamespacedPodLog.mockResolvedValue({ body: 'line one\nline two\n' });

      const logs = await service.getLogs('stripe-abc123', 50);

      const logCall = coreApi.readNamespacedPodLog.mock.calls[0];
      expect(logCall[0]).toBe('new-pod');
      expect(logCall[1]).toBe('mcp-servers');
      expect(logCall[2]).toBe('mcp-server');
      expect(logCall[9]).toBe(50); // tailLines
      expect(logs).toEqual(['line one', 'line two']);
    });

    it('returns nothing when no pod exists', async () => {
      coreApi.listNamespacedPod.mockResolvedValue({ body: { items: [] } });

      expect(await service.getLogs('stripe-abc123')).toEqual([]);
      expect(coreApi.readNamespacedPodLog).not.toHaveBeenCalled();
    });
  });

  describe('when no kubeconfig is available', () => {
    beforeEach(() => {
      (service as unknown as { appsApi: unknown }).appsApi = null;
      (service as unknown as { coreApi: unknown }).coreApi = null;
    });

    it('reports itself disabled rather than throwing at construction', () => {
      expect(service.isEnabled()).toBe(false);
    });

    it('fails with an actionable message instead of a stack trace', async () => {
      await expect(
        service.applyServer({ ...config, dockerImage: 'x' }),
      ).rejects.toThrow(/HOSTING_MODE=docker-run/);
    });

    it('reports unknown rather than missing when asked for state', async () => {
      expect((await service.getObservedState('x')).status).toBe('unknown');
    });
  });
});
