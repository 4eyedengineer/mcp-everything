import { ConfigService } from '@nestjs/config';
import { HttpError } from '@kubernetes/client-node';
import {
  K8sTestSandboxService,
  TEST_SANDBOX_INIT_CONTAINER,
  TEST_SANDBOX_MAIN_CONTAINER,
  TEST_SANDBOX_PORT,
  CreateSandboxInput,
  TestSandboxHandle,
  toK8sMemory,
} from './k8s-test-sandbox.service';

describe('toK8sMemory (Docker -> Kubernetes memory units)', () => {
  it('converts Docker lowercase suffixes to IEC units', () => {
    expect(toK8sMemory('512m')).toBe('512Mi');
    expect(toK8sMemory('1g')).toBe('1Gi');
    expect(toK8sMemory('256k')).toBe('256Ki');
    expect(toK8sMemory('2G')).toBe('2Gi');
    expect(toK8sMemory('1gb')).toBe('1Gi');
  });
  it('passes through values already in k8s IEC form', () => {
    expect(toK8sMemory('512Mi')).toBe('512Mi');
    expect(toK8sMemory('1Gi')).toBe('1Gi');
  });
  it('passes through plain byte counts and returns undefined for empty input', () => {
    expect(toK8sMemory('536870912')).toBe('536870912');
    expect(toK8sMemory(undefined)).toBeUndefined();
    expect(toK8sMemory('')).toBeUndefined();
  });
});

describe('buildDeployment normalises the memory limit', () => {
  it('never emits a bare-m limit smaller than the request', () => {
    const svc = new K8sTestSandboxService({ get: (_k: string, d?: unknown) => d } as never);
    const dep = svc.buildDeployment({
      testId: 'abc123',
      files: { 'src/index.ts': 'x' },
      resources: { memoryLimit: '512m', cpuLimit: '0.5' },
    } as CreateSandboxInput);
    const mem = dep.spec?.template?.spec?.containers?.[0]?.resources?.limits?.['memory'];
    expect(mem).toBe('512Mi');
  });
});

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
    // Replace whatever initClients() produced with our mocks, so isEnabled()
    // (which only ever reads these two fields, never used for real
    // operations post-fix) reports true.
    (service as unknown as { appsApi: unknown }).appsApi = apps;
    (service as unknown as { coreApi: unknown }).coreApi = core;
    // Every real operation now builds FRESH clients per call via
    // freshApis() instead of reusing appsApi/coreApi (see Fix 2). Mock that
    // seam directly rather than the KubeConfig/makeApiClient boundary it
    // wraps, mirroring the existing appsApi/coreApi mocking style above.
    jest
      .spyOn(service as unknown as { freshApis: () => unknown }, 'freshApis')
      .mockReturnValue({ apps, core });
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

  /**
   * Regression coverage for the production bug: a client cached ONCE in the
   * constructor (initClients()) failed every real operation with a generic
   * "HTTP request failed", while a brand-new client performing the identical
   * call succeeded. Every real operation must build its own fresh client via
   * freshApis() instead of reusing appsApi/coreApi.
   */
  describe('fresh API clients per operation', () => {
    it('builds a fresh client (via freshApis()) for each real operation, not the constructor-cached one', async () => {
      const freshApisSpy = (service as unknown as { freshApis: jest.Mock }).freshApis;
      const callsBefore = freshApisSpy.mock.calls.length;

      await service.createSandbox(input);
      await service.destroySandbox({ name: service.objectName(input.testId), testId: input.testId });

      core.listNamespacedPod.mockResolvedValue({
        body: {
          items: [
            {
              metadata: { name: 'mcptest-pod' },
              status: {
                initContainerStatuses: [
                  { name: TEST_SANDBOX_INIT_CONTAINER, state: { terminated: { exitCode: 0 } } },
                ],
                containerStatuses: [{ name: TEST_SANDBOX_MAIN_CONTAINER, ready: true }],
              },
            },
          ],
        },
      });
      await service.waitForSandboxReady(
        { name: service.objectName(input.testId), testId: input.testId },
        5000,
      );

      // One freshApis() call per operation (createSandbox, destroySandbox,
      // waitForSandboxReady) - never zero, and never reusing a single call
      // across all three.
      expect(freshApisSpy.mock.calls.length - callsBefore).toBeGreaterThanOrEqual(3);
    });

    it('never uses the constructor-cached appsApi/coreApi to perform a real operation', async () => {
      // Sabotage the constructor-cached fields: if any real operation used
      // them directly (the bug), this would throw and fail the test.
      const poisoned = {
        createNamespacedDeployment: jest.fn(() => {
          throw new Error('BUG: used the constructor-cached client, not a fresh one');
        }),
      };
      (service as unknown as { appsApi: unknown }).appsApi = poisoned;
      // freshApis() is still mocked (see beforeEach) to return the real
      // working mocks, exactly like a fixed fresh-client build would.

      const handle = await service.createSandbox(input);

      expect(handle.name).toMatch(/^mcptest-/);
      expect(poisoned.createNamespacedDeployment).not.toHaveBeenCalled();
      expect(apps.createNamespacedDeployment).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * Regression coverage for the other half of the production bug: the
   * generic "HTTP request failed" `HttpError.message` hid the real
   * status/body, so the true cause (e.g. a 401/403/422) never made it to the
   * logs.
   */
  describe('HttpError diagnostics', () => {
    it('surfaces statusCode and a body snippet, not just the generic HttpError message', async () => {
      const httpError = new HttpError(
        { statusCode: 403 } as never,
        { kind: 'Status', message: 'secrets is forbidden: User cannot create resource', reason: 'Forbidden' },
        403,
      );
      expect(httpError.message).toBe('HTTP request failed'); // the useless generic message
      core.createNamespacedSecret.mockRejectedValue(httpError);

      await expect(service.createSandbox(input)).rejects.toThrow();

      const message = (service as unknown as { errorMessage: (e: unknown) => string }).errorMessage(
        httpError,
      );
      expect(message).not.toBe('HTTP request failed');
      expect(message).toContain('403');
      expect(message).toContain('Forbidden');
      expect(message).toContain('cannot create resource');
    });

    it('caps the logged body snippet so a huge error body cannot flood the logs', () => {
      const hugeBody = { message: 'x'.repeat(2000) };
      const httpError = new HttpError({} as never, hugeBody, 422);

      const message = (service as unknown as { errorMessage: (e: unknown) => string }).errorMessage(
        httpError,
      );

      expect(message.length).toBeLessThan(600);
    });

    it('still returns a plain message for non-HttpError errors', () => {
      const message = (service as unknown as { errorMessage: (e: unknown) => string }).errorMessage(
        new Error('plain failure'),
      );
      expect(message).toBe('plain failure');
    });
  });
});
