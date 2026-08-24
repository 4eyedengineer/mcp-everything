import { ConfigService } from '@nestjs/config';
import {
  K8sTestSandboxService,
  TEST_SANDBOX_INIT_CONTAINER,
  TEST_SANDBOX_MAIN_CONTAINER,
  TEST_SANDBOX_PORT,
  CreateSandboxInput,
  TestSandboxHandle,
} from './k8s-test-sandbox.service';

/**
 * Unit tests for the Kubernetes test-pod sandbox. There is no cluster in CI,
 * so the @kubernetes/client-node boundary is mocked, but the real
 * orchestration (object construction, ordering, rollback, readiness parsing,
 * teardown) is exercised.
 *
 * The security assertions here are the important ones: a test pod that runs
 * untrusted, LLM-generated code MUST be at least as locked down as a hosted
 * server, or the k8s path would be a worse-than-Docker escape hatch.
 */
describe('K8sTestSandboxService', () => {
  let service: K8sTestSandboxService;
  let apps: {
    createNamespacedDeployment: jest.Mock;
    deleteNamespacedDeployment: jest.Mock;
  };
  let core: {
    createNamespacedSecret: jest.Mock;
    createNamespacedService: jest.Mock;
    deleteNamespacedSecret: jest.Mock;
    deleteNamespacedService: jest.Mock;
    listNamespacedPod: jest.Mock;
    readNamespacedPodLog: jest.Mock;
  };

  const config = {
    get: jest.fn((key: string, fallback?: unknown) => {
      if (key === 'K8S_NAMESPACE') return 'mcp-servers';
      if (key === 'MCP_TESTING_DOCKER_IMAGE') return 'node:20-alpine';
      return fallback;
    }),
  } as unknown as ConfigService;

  const input: CreateSandboxInput = {
    testId: 'abcd1234-ef56-7890-abcd-ef1234567890',
    files: {
      'src/index.ts': 'console.log("hi")',
      'package.json': '{"name":"x"}',
      'tsconfig.json': '{}',
      'lib/util.ts': 'export const a = 1;',
    },
  };

  beforeEach(() => {
    apps = {
      createNamespacedDeployment: jest.fn().mockResolvedValue({}),
      deleteNamespacedDeployment: jest.fn().mockResolvedValue({}),
    };
    core = {
      createNamespacedSecret: jest.fn().mockResolvedValue({}),
      createNamespacedService: jest.fn().mockResolvedValue({}),
      deleteNamespacedSecret: jest.fn().mockResolvedValue({}),
      deleteNamespacedService: jest.fn().mockResolvedValue({}),
      listNamespacedPod: jest.fn(),
      readNamespacedPodLog: jest.fn().mockResolvedValue({ body: '' }),
    };
    service = new K8sTestSandboxService(config);
    // Replace whatever initClients() produced with our mocks.
    (service as unknown as { appsApi: unknown }).appsApi = apps;
    (service as unknown as { coreApi: unknown }).coreApi = core;
  });

  describe('manifest hardening', () => {
    it('applies the same hardened securityContext a hosted server gets', () => {
      const dep = service.buildDeployment(input);
      const podSpec = dep.spec!.template!.spec!;

      // Pod-level: no projected SA token, non-root, seccomp RuntimeDefault.
      expect(podSpec.automountServiceAccountToken).toBe(false);
      expect(podSpec.serviceAccountName).toBe('mcp-server-runtime');
      expect(podSpec.securityContext!.runAsNonRoot).toBe(true);
      expect(podSpec.securityContext!.runAsUser).toBe(1000);
      expect(podSpec.securityContext!.fsGroup).toBe(1000);
      expect(podSpec.securityContext!.seccompProfile).toEqual({ type: 'RuntimeDefault' });

      const containers = [...(podSpec.initContainers || []), ...(podSpec.containers || [])];
      expect(containers).toHaveLength(2);
      for (const c of containers) {
        expect(c.securityContext!.runAsNonRoot).toBe(true);
        expect(c.securityContext!.allowPrivilegeEscalation).toBe(false);
        expect(c.securityContext!.readOnlyRootFilesystem).toBe(true);
        expect(c.securityContext!.capabilities).toEqual({ drop: ['ALL'] });
        // Explicit CPU + memory limits (LimitRange/ResourceQuota).
        expect(c.resources!.limits!.cpu).toBeDefined();
        expect(c.resources!.limits!.memory).toBeDefined();
      }
    });

    it('never sets host mounts, privileged, hostNetwork, or a host path', () => {
      const dep = service.buildDeployment(input);
      const podSpec = dep.spec!.template!.spec!;

      expect((podSpec as { hostNetwork?: boolean }).hostNetwork).toBeUndefined();
      expect((podSpec as { hostPID?: boolean }).hostPID).toBeUndefined();

      // Only emptyDir + the source Secret; no hostPath volume.
      for (const vol of podSpec.volumes || []) {
        expect((vol as { hostPath?: unknown }).hostPath).toBeUndefined();
        const isAllowed = 'emptyDir' in vol || 'secret' in vol;
        expect(isAllowed).toBe(true);
      }

      const containers = [...(podSpec.initContainers || []), ...(podSpec.containers || [])];
      for (const c of containers) {
        expect((c.securityContext as { privileged?: boolean }).privileged).toBeUndefined();
        // No mount escapes onto the host filesystem.
        for (const m of c.volumeMounts || []) {
          expect(m.mountPath.startsWith('/app') || m.mountPath === '/tmp' || m.mountPath === '/src').toBe(
            true,
          );
        }
      }
    });

    it('carries the app=mcp-server label so the namespace NetworkPolicy applies', () => {
      const dep = service.buildDeployment(input);
      expect(dep.metadata!.labels!.app).toBe('mcp-server');
      expect(dep.spec!.template!.metadata!.labels!.app).toBe('mcp-server');
      expect(dep.spec!.selector!.matchLabels!.app).toBe('mcp-server');
    });

    it('serves over MCP_TRANSPORT=http on the expected port with a readiness probe', () => {
      const dep = service.buildDeployment(input);
      const main = dep.spec!.template!.spec!.containers!.find(
        (c) => c.name === TEST_SANDBOX_MAIN_CONTAINER,
      )!;
      expect(main.env).toEqual(
        expect.arrayContaining([
          { name: 'MCP_TRANSPORT', value: 'http' },
          { name: 'PORT', value: String(TEST_SANDBOX_PORT) },
        ]),
      );
      expect(main.ports![0].containerPort).toBe(TEST_SANDBOX_PORT);
      expect(main.readinessProbe!.httpGet!.path).toBe('/health');
    });

    it('materialises source and runs npm install --ignore-scripts + tsc in the init container', () => {
      const dep = service.buildDeployment(input);
      const init = dep.spec!.template!.spec!.initContainers!.find(
        (c) => c.name === TEST_SANDBOX_INIT_CONTAINER,
      )!;
      const script = (init.command || []).join(' ');
      expect(script).toContain('npm install --ignore-scripts');
      expect(script).toContain('npx tsc');
      expect(script).toContain('source.json');
    });
  });

  describe('buildSecret', () => {
    it('serialises all files into a single Secret key and names it <obj>-src', () => {
      const secret = service.buildSecret(input);
      const name = service.objectName(input.testId);
      expect(secret.metadata!.name).toBe(`${name}-src`);
      const parsed = JSON.parse(secret.stringData!['source.json']);
      expect(parsed).toEqual(input.files);
    });

    it('rejects source that would exceed the Secret size limit', () => {
      const huge = { 'src/index.ts': 'x'.repeat(1_000_000) };
      expect(() => service.buildSecret({ testId: input.testId, files: huge })).toThrow(/exceeding/);
    });
  });

  describe('buildService', () => {
    it('is a ClusterIP Service on the sandbox port', () => {
      const svc = service.buildService(input);
      expect(svc.spec!.type).toBe('ClusterIP');
      expect(svc.spec!.ports![0].targetPort).toBe(TEST_SANDBOX_PORT);
    });
  });

  describe('createSandbox', () => {
    it('creates Secret, then Deployment, then Service (secret before the deployment that mounts it)', async () => {
      const order: string[] = [];
      core.createNamespacedSecret.mockImplementation(async () => void order.push('secret'));
      apps.createNamespacedDeployment.mockImplementation(async () => void order.push('deployment'));
      core.createNamespacedService.mockImplementation(async () => void order.push('service'));

      const handle = await service.createSandbox(input);

      expect(order).toEqual(['secret', 'deployment', 'service']);
      expect(handle.name).toMatch(/^mcptest-/);
    });

    it('rolls back (deletes what it created) and rethrows when a create fails', async () => {
      core.createNamespacedService.mockRejectedValue(new Error('quota exceeded'));

      await expect(service.createSandbox(input)).rejects.toThrow('quota exceeded');

      // Rollback deletes all three (404s are swallowed inside destroySandbox).
      expect(apps.deleteNamespacedDeployment).toHaveBeenCalledTimes(1);
      expect(core.deleteNamespacedService).toHaveBeenCalledTimes(1);
      expect(core.deleteNamespacedSecret).toHaveBeenCalledTimes(1);
    });
  });

  describe('destroySandbox', () => {
    const handle: TestSandboxHandle = { name: 'mcptest-abcd1234ef56', testId: input.testId };

    it('deletes Deployment, Service and Secret', async () => {
      const errors = await service.destroySandbox(handle);
      expect(errors).toEqual([]);
      expect(apps.deleteNamespacedDeployment).toHaveBeenCalledWith(
        'mcptest-abcd1234ef56',
        'mcp-servers',
        undefined,
        undefined,
        undefined,
        undefined,
        'Background',
      );
      expect(core.deleteNamespacedService).toHaveBeenCalled();
      expect(core.deleteNamespacedSecret).toHaveBeenCalled();
    });

    it('ignores 404s but reports other delete failures as cleanup errors', async () => {
      core.deleteNamespacedService.mockRejectedValue({ statusCode: 404 });
      core.deleteNamespacedSecret.mockRejectedValue({ statusCode: 500, message: 'boom' });

      const errors = await service.destroySandbox(handle);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/secret/);
    });
  });

  describe('waitForSandboxReady', () => {
    const handle: TestSandboxHandle = { name: 'mcptest-abcd1234ef56', testId: input.testId };

    const podWith = (overrides: Record<string, unknown>) => ({
      body: { items: [{ metadata: { name: 'mcptest-pod' }, status: overrides }] },
    });

    it('returns ready once the main container reports ready', async () => {
      core.listNamespacedPod.mockResolvedValue(
        podWith({
          initContainerStatuses: [
            { name: TEST_SANDBOX_INIT_CONTAINER, state: { terminated: { exitCode: 0 } } },
          ],
          containerStatuses: [{ name: TEST_SANDBOX_MAIN_CONTAINER, ready: true }],
        }),
      );

      const result = await service.waitForSandboxReady(handle, 5000);
      expect(result).toEqual({ ready: true, buildSucceeded: true });
    });

    it('reports a build failure (with log tail) when the init container exits non-zero', async () => {
      core.listNamespacedPod.mockResolvedValue(
        podWith({
          initContainerStatuses: [
            { name: TEST_SANDBOX_INIT_CONTAINER, state: { terminated: { exitCode: 2 } } },
          ],
          containerStatuses: [],
        }),
      );
      core.readNamespacedPodLog.mockResolvedValue({ body: 'error TS2304: Cannot find name foo' });

      const result = await service.waitForSandboxReady(handle, 5000);
      expect(result.ready).toBe(false);
      expect(result.buildSucceeded).toBe(false);
      expect(result.error).toContain('TS2304');
    });

    it('times out (build not finished) and reports it without throwing', async () => {
      core.listNamespacedPod.mockResolvedValue(
        podWith({
          initContainerStatuses: [{ name: TEST_SANDBOX_INIT_CONTAINER, state: { running: {} } }],
          containerStatuses: [],
        }),
      );

      const result = await service.waitForSandboxReady(handle, 50);
      expect(result.ready).toBe(false);
      expect(result.buildSucceeded).toBe(false);
      expect(result.error).toMatch(/did not become ready/);
    });
  });
});
