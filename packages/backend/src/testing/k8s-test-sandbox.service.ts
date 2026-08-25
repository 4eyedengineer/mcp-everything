import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AppsV1Api,
  CoreV1Api,
  HttpError,
  KubeConfig,
  V1Deployment,
  V1Pod,
  V1Secret,
  V1Service,
} from '@kubernetes/client-node';

/**
 * Runs untrusted, LLM-generated MCP servers for the generate-test-refine loop
 * inside an isolated, short-lived Kubernetes workload, for the case where the
 * backend pod has NO Docker daemon (the cluster).
 *
 * This is the "real sandbox" the security fix deliberately deferred: in the
 * cluster the backend must never run generated code in its own pod, and it has
 * no docker socket to shell out to. Instead, per test run, this service:
 *
 *   1. writes the generated source into a Secret (small text, well under the
 *      1 MiB Secret limit),
 *   2. starts a one-replica Deployment whose initContainer materialises that
 *      source, runs `npm install --ignore-scripts` + `tsc`, and whose main
 *      container serves the compiled server over MCP Streamable HTTP,
 *   3. exposes it via a temporary ClusterIP Service,
 *   4. and tears all three down afterwards.
 *
 * McpTestingService then drives the MCP handshake + per-tool calls over the
 * Service DNS name using the same `McpHttpTransportClient` the Docker path
 * uses. This service does no wire-protocol work itself.
 *
 * SECURITY / ISOLATION. The test pod is treated as exactly as hostile as a
 * hosted server (see manifest-generator.service.ts):
 *   - `automountServiceAccountToken: false` and the bound-to-nothing
 *     `mcp-server-runtime` ServiceAccount, so generated code cannot reach the
 *     Kubernetes API,
 *   - `runAsNonRoot`, non-root uid, `allowPrivilegeEscalation: false`,
 *     `readOnlyRootFilesystem: true` (with writable emptyDirs for /app and
 *     /tmp only), `seccompProfile: RuntimeDefault`, `capabilities.drop: ALL`,
 *   - the `app: mcp-server` label, so the mcp-servers namespace NetworkPolicy
 *     applies (no LAN / Postgres / kube-apiserver / metadata egress; only DNS,
 *     the backend, and the public internet), and explicit CPU/memory limits so
 *     the LimitRange/ResourceQuota are satisfied.
 *
 * RBAC. Every call here stays within the verbs the backend already has in
 * k8s/mcp-servers/rbac.yaml: create/get/list/watch/patch/delete on secrets,
 * deployments and services, and get/list/watch on pods (+ get on pods/log).
 * No ConfigMaps, no Jobs, no exec — the source ships in a Secret, readiness is
 * polled via pods, and the handshake goes over the Service.
 *
 * The image is a plain public `node` image (the same base the Docker path uses
 * via MCP_TESTING_DOCKER_IMAGE) with an inline build+serve command; the shared
 * production `mcp-runner` image is deliberately NOT used here, so nothing about
 * how hosted servers are built/run is touched.
 */

/** Port the test server listens on (matches the hosted MCP container port). */
export const TEST_SANDBOX_PORT = 3000;

/** initContainer name: `kubectl logs <pod> -c sandbox-build` surfaces build failures. */
export const TEST_SANDBOX_INIT_CONTAINER = 'sandbox-build';

/** Main (serving) container name. */
export const TEST_SANDBOX_MAIN_CONTAINER = 'sandbox-server';

/** emptyDir shared between the init and main containers (the compiled app). */
const APP_VOLUME = 'app';
const APP_MOUNT = '/app';
const TMP_VOLUME = 'tmp';
const TMP_MOUNT = '/tmp';
const SRC_VOLUME = 'source';
const SRC_MOUNT = '/src';

/** Single Secret key the generated source is serialised under. */
const SOURCE_KEY = 'source.json';

/**
 * uid/gid the pod runs as. node images ship a `node` user at 1000:1000;
 * fsGroup must match so the shared emptyDir is writable by that non-root user
 * (Kubernetes does not apply an image's dir ownership to a mounted emptyDir).
 */
const RUN_UID = 1000;

/** app label every hosted/test workload carries, so the NetworkPolicy selects it. */
const APP_LABEL = 'mcp-server';
const SERVER_ID_LABEL = 'server-id';

/** Hard ceiling on the serialised source, comfortably under the 1 MiB Secret limit. */
const MAX_SOURCE_BYTES = 900 * 1024;

/** Opaque handle returned by createSandbox and threaded back into the other calls. */
export interface TestSandboxHandle {
  /** Object name shared by the Deployment, Service and (as `<name>-src`) Secret. */
  name: string;
  testId: string;
}

/** Resource knobs, mirrored from McpTestConfig; sensible defaults applied here. */
export interface TestSandboxResources {
  cpuLimit?: string;
  memoryLimit?: string;
}

export interface CreateSandboxInput {
  testId: string;
  /** Relative path -> file contents, e.g. { 'src/index.ts': '...', 'package.json': '...' }. */
  files: Record<string, string>;
  resources?: TestSandboxResources;
}

/**
 * Outcome of waiting for a sandbox to come up.
 *  - ready:            main container is serving; drive the handshake.
 *  - buildSucceeded:   the initContainer (npm install + tsc) completed. Lets
 *                      the caller populate McpServerTestResult.buildSuccess
 *                      correctly even when the server then failed to serve.
 *  - error:            populated whenever ready === false.
 */
export interface SandboxReadiness {
  ready: boolean;
  buildSucceeded: boolean;
  error?: string;
}

const FATAL_WAITING_REASONS = new Set([
  'ImagePullBackOff',
  'ErrImagePull',
  'InvalidImageName',
  'CrashLoopBackOff',
  'CreateContainerConfigError',
  'CreateContainerError',
  'RunContainerError',
]);

@Injectable()
export class K8sTestSandboxService {
  private readonly logger = new Logger(K8sTestSandboxService.name);

  readonly namespace: string;
  /** Public image used to run untrusted install/compile/serve steps in the pod. */
  readonly testImage: string;

  /**
   * Populated only by the one-time constructor probe (initClients()) to
   * decide isEnabled()/availability. NEVER used to perform a real operation
   * — see freshApis() for why: a client cached for the lifetime of the
   * backend process is the root cause of a production bug where every real
   * create (Secret/Deployment/Service) failed with a generic "HTTP request
   * failed", while an identical create using a brand-new client succeeded.
   */
  private appsApi: AppsV1Api | null = null;
  private coreApi: CoreV1Api | null = null;
  private initError: string | null = null;

  constructor(private readonly configService: ConfigService) {
    this.namespace = this.configService.get<string>('K8S_NAMESPACE', 'mcp-servers');
    this.testImage = this.configService.get<string>('MCP_TESTING_DOCKER_IMAGE', 'node:20-alpine');
    this.initClients();
  }

  /**
   * Load a kubeconfig if one is reachable. Non-fatal (mirrors
   * K8sControlPlaneService): the backend must still boot on a dev machine with
   * no cluster. Availability surfaces via isEnabled(); loadFromDefault()
   * already covers the in-cluster ServiceAccount case as its final fallback.
   *
   * This is a PROBE only, run once at startup to populate isEnabled(). The
   * clients it builds are never reused for a real operation; see
   * freshApis().
   */
  private initClients(): void {
    try {
      const kubeConfig = new KubeConfig();
      kubeConfig.loadFromDefault();
      this.appsApi = kubeConfig.makeApiClient(AppsV1Api);
      this.coreApi = kubeConfig.makeApiClient(CoreV1Api);
      this.logger.log(
        `K8s test sandbox initialized for namespace '${this.namespace}' ` +
          `(context: ${kubeConfig.getCurrentContext() || 'unknown'}, image: ${this.testImage})`,
      );
    } catch (error) {
      this.initError = error instanceof Error ? error.message : 'Unknown error';
      this.appsApi = null;
      this.coreApi = null;
      this.logger.warn(
        `No usable Kubernetes configuration (${this.initError}). ` +
          'The Kubernetes test-pod sandbox is unavailable.',
      );
    }
  }

  /**
   * Build a brand-new KubeConfig + typed API clients. Called once from
   * initClients() to probe availability, and again, freshly, by freshApis()
   * on every real operation.
   */
  private buildClients(): { apps: AppsV1Api; core: CoreV1Api } {
    const kubeConfig = new KubeConfig();
    kubeConfig.loadFromDefault();
    return {
      apps: kubeConfig.makeApiClient(AppsV1Api),
      core: kubeConfig.makeApiClient(CoreV1Api),
    };
  }

  /** True when a cluster is reachable and the k8s test-pod path can be used. */
  isEnabled(): boolean {
    return this.appsApi !== null && this.coreApi !== null;
  }

  /**
   * Build FRESH API clients for a single real operation (create/wait/
   * destroy/log). Deliberately never reuses the clients cached by the
   * constructor probe (this.appsApi/this.coreApi), which is the fix for a
   * production bug: those long-lived clients failed EVERY real operation
   * with a generic "HTTP request failed", while a brand-new
   * `new KubeConfig(); loadFromDefault(); makeApiClient(...)` performing the
   * exact same call succeeded (confirmed by manual reproduction inside the
   * backend pod). Rather than chase the exact staleness mechanism (most
   * likely an expired/rotated in-cluster token or exec-plugin credential the
   * cached client never refreshes), every real operation now builds its own
   * short-lived clients, matching the working reproduction exactly.
   */
  private freshApis(): { apps: AppsV1Api; core: CoreV1Api } {
    return this.buildClients();
  }

  private requireApis(): { apps: AppsV1Api; core: CoreV1Api } {
    if (!this.isEnabled()) {
      throw new Error(
        `Kubernetes test sandbox is not available${this.initError ? `: ${this.initError}` : ''}.`,
      );
    }
    try {
      return this.freshApis();
    } catch (error) {
      throw new Error(`Kubernetes test sandbox is not available: ${this.errorMessage(error)}`);
    }
  }

  /** Object name for a test run; DNS-1035 safe (starts with a letter). */
  objectName(testId: string): string {
    const short =
      testId
        .replace(/[^a-z0-9]/gi, '')
        .slice(0, 12)
        .toLowerCase() || 'run';
    return `mcptest-${short}`;
  }

  private secretName(name: string): string {
    return `${name}-src`;
  }

  /**
   * The in-cluster URL the backend uses to drive the handshake. Kept as a
   * method so it can be mocked in tests to point at an in-process server.
   */
  serviceBaseUrl(handle: TestSandboxHandle): string {
    return `http://${handle.name}.${this.namespace}.svc.cluster.local:${TEST_SANDBOX_PORT}`;
  }

  // --- manifest builders (pure; public so tests can assert the hardening) ---

  labelsFor(name: string): Record<string, string> {
    return {
      // REQUIRED: the mcp-servers NetworkPolicy selects `app: mcp-server`, so
      // without this label the pod would get unrestricted egress (LAN,
      // Postgres, metadata endpoints). Test pods must be as locked down as
      // hosted servers.
      app: APP_LABEL,
      [SERVER_ID_LABEL]: name,
      'app.kubernetes.io/managed-by': 'mcp-everything',
      // Distinguishes a throwaway test pod from a real hosted server. Not a
      // selector label; purely for humans reading `kubectl get pods`.
      'mcp-everything.dev/component': 'test-sandbox',
    };
  }

  private selectorFor(name: string): Record<string, string> {
    return { app: APP_LABEL, [SERVER_ID_LABEL]: name };
  }

  buildSecret(input: CreateSandboxInput): V1Secret {
    const name = this.objectName(input.testId);
    const serialized = JSON.stringify(input.files);
    const bytes = Buffer.byteLength(serialized, 'utf8');
    if (bytes > MAX_SOURCE_BYTES) {
      throw new Error(
        `Generated source is ${bytes} bytes, exceeding the ${MAX_SOURCE_BYTES}-byte test-sandbox Secret limit.`,
      );
    }
    return {
      apiVersion: 'v1',
      kind: 'Secret',
      type: 'Opaque',
      metadata: {
        name: this.secretName(name),
        namespace: this.namespace,
        labels: this.labelsFor(name),
      },
      // stringData: sent as-is and base64-encoded by the API server. Never
      // logged anywhere in this service.
      stringData: { [SOURCE_KEY]: serialized },
    };
  }

  buildService(input: CreateSandboxInput): V1Service {
    const name = this.objectName(input.testId);
    return {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name, namespace: this.namespace, labels: this.labelsFor(name) },
      spec: {
        // ClusterIP only: the sandbox is reachable from the backend pod and
        // nothing else. Never exposed outside the cluster.
        type: 'ClusterIP',
        selector: this.selectorFor(name),
        ports: [
          { name: 'http', port: TEST_SANDBOX_PORT, targetPort: TEST_SANDBOX_PORT, protocol: 'TCP' },
        ],
      },
    };
  }

  /**
   * The build+serve script the initContainer runs. Kept as a small, commented
   * builder rather than an opaque blob. Runs under `sh -c` as a single arg:
   *  1. materialise the generated files from the mounted Secret into /app,
   *  2. `npm install --ignore-scripts` (blocks malicious pre/postinstall),
   *  3. `tsc`,
   *  4. assert dist/index.js exists, so a silent "compiled nothing" fails loud.
   * The JS one-liner uses single quotes so its double-quoted internals need no
   * escaping inside the surrounding double-quoted sh script.
   */
  buildInitScript(): string {
    const materialise =
      `node -e 'const fs=require("fs"),p=require("path");` +
      `const files=JSON.parse(fs.readFileSync("${SRC_MOUNT}/${SOURCE_KEY}","utf8"));` +
      `for(const [rel,content] of Object.entries(files)){` +
      `const dest=p.join("${APP_MOUNT}",rel);` +
      `fs.mkdirSync(p.dirname(dest),{recursive:true});` +
      `fs.writeFileSync(dest,content);}'`;
    return [
      'set -e',
      `cd ${APP_MOUNT}`,
      materialise,
      'npm install --ignore-scripts --no-audit --no-fund',
      'npx tsc',
      'test -f dist/index.js || { echo "build produced no dist/index.js" >&2; exit 3; }',
    ].join('\n');
  }

  buildDeployment(input: CreateSandboxInput): V1Deployment {
    const name = this.objectName(input.testId);
    const memoryLimit = input.resources?.memoryLimit || '512Mi';
    const cpuLimit = input.resources?.cpuLimit || '1000m';

    const commonSecurityContext = {
      runAsNonRoot: true,
      runAsUser: RUN_UID,
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ['ALL'] },
    };

    return {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name, namespace: this.namespace, labels: this.labelsFor(name) },
      spec: {
        replicas: 1,
        selector: { matchLabels: this.selectorFor(name) },
        template: {
          metadata: { labels: this.labelsFor(name) },
          spec: {
            // Bound-to-nothing ServiceAccount + no projected token: generated
            // code cannot talk to the Kubernetes API. Pod-level setting is the
            // one that actually wins.
            serviceAccountName: 'mcp-server-runtime',
            automountServiceAccountToken: false,
            securityContext: {
              runAsNonRoot: true,
              runAsUser: RUN_UID,
              runAsGroup: RUN_UID,
              // Makes the shared emptyDir writable by the non-root user.
              fsGroup: RUN_UID,
              seccompProfile: { type: 'RuntimeDefault' },
            },
            initContainers: [
              {
                name: TEST_SANDBOX_INIT_CONTAINER,
                image: this.testImage,
                command: ['sh', '-c', this.buildInitScript()],
                env: [
                  // HOME + npm cache must live on a writable volume because the
                  // root filesystem is read-only.
                  { name: 'HOME', value: APP_MOUNT },
                  { name: 'npm_config_cache', value: `${APP_MOUNT}/.npm` },
                ],
                resources: {
                  // tsc is memory-hungry; a 256Mi cap OOM-kills it. This is a
                  // limit on a short-lived container, not a standing reserve.
                  requests: { cpu: '250m', memory: '256Mi' },
                  limits: { cpu: '1000m', memory: '768Mi' },
                },
                securityContext: commonSecurityContext,
                volumeMounts: [
                  { name: APP_VOLUME, mountPath: APP_MOUNT },
                  { name: TMP_VOLUME, mountPath: TMP_MOUNT },
                  { name: SRC_VOLUME, mountPath: SRC_MOUNT, readOnly: true },
                ],
              },
            ],
            containers: [
              {
                name: TEST_SANDBOX_MAIN_CONTAINER,
                image: this.testImage,
                command: ['node', 'dist/index.js'],
                workingDir: APP_MOUNT,
                ports: [{ name: 'http', containerPort: TEST_SANDBOX_PORT, protocol: 'TCP' }],
                env: [
                  { name: 'MCP_TRANSPORT', value: 'http' },
                  { name: 'PORT', value: String(TEST_SANDBOX_PORT) },
                  { name: 'NODE_ENV', value: 'test' },
                  { name: 'HOME', value: APP_MOUNT },
                ],
                resources: {
                  requests: { cpu: '100m', memory: '128Mi' },
                  limits: { cpu: cpuLimit, memory: memoryLimit },
                },
                securityContext: commonSecurityContext,
                volumeMounts: [
                  { name: APP_VOLUME, mountPath: APP_MOUNT },
                  { name: TMP_VOLUME, mountPath: TMP_MOUNT },
                ],
                readinessProbe: {
                  httpGet: { path: '/health', port: TEST_SANDBOX_PORT },
                  initialDelaySeconds: 2,
                  periodSeconds: 3,
                },
              },
            ],
            volumes: [
              { name: APP_VOLUME, emptyDir: {} },
              { name: TMP_VOLUME, emptyDir: {} },
              { name: SRC_VOLUME, secret: { secretName: this.secretName(name) } },
            ],
          },
        },
      },
    };
  }

  // --- lifecycle ---

  /**
   * Create Secret -> Deployment -> Service for one test run. Secret first, so
   * the Deployment's source volume never references a Secret that does not
   * exist yet. On partial failure, best-effort deletes whatever was created and
   * rethrows, so a failed create never leaks objects.
   */
  async createSandbox(input: CreateSandboxInput): Promise<TestSandboxHandle> {
    const { core, apps } = this.requireApis();
    const name = this.objectName(input.testId);
    const handle: TestSandboxHandle = { name, testId: input.testId };

    const secret = this.buildSecret(input);
    const deployment = this.buildDeployment(input);
    const service = this.buildService(input);

    try {
      await core.createNamespacedSecret(this.namespace, secret);
      await apps.createNamespacedDeployment(this.namespace, deployment);
      await core.createNamespacedService(this.namespace, service);
    } catch (error) {
      this.logger.warn(
        `[${input.testId}] Failed to create test sandbox '${name}': ${this.errorMessage(error)}; rolling back.`,
      );
      await this.destroySandbox(handle);
      throw error;
    }

    this.logger.log(`[${input.testId}] Created test sandbox '${name}' in ${this.namespace}`);
    return handle;
  }

  /**
   * Poll pod status until the main container is serving, the build fails, or
   * the timeout elapses. Uses only pods (list) + pods/log (get) — the verbs
   * the backend already has.
   */
  async waitForSandboxReady(
    handle: TestSandboxHandle,
    timeoutMs: number,
  ): Promise<SandboxReadiness> {
    const { core } = this.requireApis();
    const deadline = Date.now() + timeoutMs;
    const selector = `${SERVER_ID_LABEL}=${handle.name}`;

    while (Date.now() < deadline) {
      let pod: V1Pod | undefined;
      try {
        const res = await core.listNamespacedPod(
          this.namespace,
          undefined,
          undefined,
          undefined,
          undefined,
          selector,
        );
        pod = res.body.items?.[0];
      } catch (error) {
        this.logger.debug(
          `[${handle.testId}] pod list failed (will retry): ${this.errorMessage(error)}`,
        );
        await this.delay(1500);
        continue;
      }

      if (!pod) {
        await this.delay(1000);
        continue;
      }

      const initStatuses = pod.status?.initContainerStatuses || [];
      const mainStatuses = pod.status?.containerStatuses || [];

      // Build failure: the initContainer terminated non-zero, or is stuck in a
      // fatal waiting state (ImagePullBackOff, etc.).
      const init = initStatuses.find((s) => s.name === TEST_SANDBOX_INIT_CONTAINER);
      if (init?.state?.terminated && init.state.terminated.exitCode !== 0) {
        return {
          ready: false,
          buildSucceeded: false,
          error: await this.describeFailure(
            handle,
            TEST_SANDBOX_INIT_CONTAINER,
            `build step exited with code ${init.state.terminated.exitCode}`,
          ),
        };
      }
      const initWaiting = init?.state?.waiting;
      if (initWaiting?.reason && FATAL_WAITING_REASONS.has(initWaiting.reason)) {
        return {
          ready: false,
          buildSucceeded: false,
          error: `${initWaiting.reason}: ${initWaiting.message || 'init container cannot start'}`,
        };
      }

      const initDone = init?.state?.terminated?.exitCode === 0;

      // Main container ready -> serving. Success.
      const main = mainStatuses.find((s) => s.name === TEST_SANDBOX_MAIN_CONTAINER);
      if (main?.ready) {
        return { ready: true, buildSucceeded: true };
      }

      // Main container crash/looping after a successful build: server started
      // but failed to serve. Build succeeded, but there is nothing to test.
      const mainWaiting = main?.state?.waiting;
      if (mainWaiting?.reason && FATAL_WAITING_REASONS.has(mainWaiting.reason)) {
        return {
          ready: false,
          buildSucceeded: initDone,
          error: await this.describeFailure(
            handle,
            TEST_SANDBOX_MAIN_CONTAINER,
            `${mainWaiting.reason}: ${mainWaiting.message || 'server container will not start'}`,
          ),
        };
      }

      if (pod.status?.phase === 'Failed') {
        return {
          ready: false,
          buildSucceeded: initDone,
          error: `Pod failed: ${pod.status?.reason || 'no reason reported'}`,
        };
      }

      await this.delay(1500);
    }

    return {
      ready: false,
      // If the init container finished before we timed out, the build itself
      // succeeded; it was the server that never became ready.
      buildSucceeded: await this.initFinished(handle),
      error: `Test sandbox did not become ready within ${timeoutMs}ms.`,
    };
  }

  /**
   * Delete Deployment, Service and Secret. Best-effort and idempotent: a 404
   * means the object is already gone, which is the desired end state. Returns
   * the messages of any non-404 failures so the caller can surface them as
   * cleanupErrors.
   */
  async destroySandbox(handle: TestSandboxHandle): Promise<string[]> {
    if (!this.isEnabled()) {
      return ['Kubernetes test sandbox is not available; nothing to clean up.'];
    }
    let apps: AppsV1Api;
    let core: CoreV1Api;
    try {
      ({ apps, core } = this.freshApis());
    } catch (error) {
      return [
        `Kubernetes test sandbox is not available (${this.errorMessage(error)}); nothing to clean up.`,
      ];
    }
    const name = handle.name;
    const errors: string[] = [];

    // propagationPolicy=Background so the ReplicaSet and pods are actually
    // removed, not orphaned and left running.
    await this.deleteIgnoringNotFound(
      () =>
        apps.deleteNamespacedDeployment(
          name,
          this.namespace,
          undefined,
          undefined,
          undefined,
          undefined,
          'Background',
        ),
      `deployment/${name}`,
      errors,
    );
    await this.deleteIgnoringNotFound(
      () => core.deleteNamespacedService(name, this.namespace),
      `service/${name}`,
      errors,
    );
    await this.deleteIgnoringNotFound(
      () => core.deleteNamespacedSecret(this.secretName(name), this.namespace),
      `secret/${this.secretName(name)}`,
      errors,
    );

    if (errors.length === 0) {
      this.logger.log(`[${handle.testId}] Tore down test sandbox '${name}'`);
    }
    return errors;
  }

  // --- helpers ---

  private async initFinished(handle: TestSandboxHandle): Promise<boolean> {
    try {
      const { core } = this.requireApis();
      const res = await core.listNamespacedPod(
        this.namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        `${SERVER_ID_LABEL}=${handle.name}`,
      );
      const pod = res.body.items?.[0];
      const init = (pod?.status?.initContainerStatuses || []).find(
        (s) => s.name === TEST_SANDBOX_INIT_CONTAINER,
      );
      return init?.state?.terminated?.exitCode === 0;
    } catch {
      return false;
    }
  }

  /** Compose a failure message including a tail of the container's logs. */
  private async describeFailure(
    handle: TestSandboxHandle,
    container: string,
    summary: string,
  ): Promise<string> {
    const logs = await this.readContainerLog(handle, container).catch(() => '');
    const tail = logs.trim().split('\n').slice(-20).join('\n');
    return tail ? `${summary}\n--- ${container} logs (tail) ---\n${tail}` : summary;
  }

  private async readContainerLog(handle: TestSandboxHandle, container: string): Promise<string> {
    const { core } = this.requireApis();
    const list = await core.listNamespacedPod(
      this.namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      `${SERVER_ID_LABEL}=${handle.name}`,
    );
    const podName = list.body.items?.[0]?.metadata?.name;
    if (!podName) return '';
    const res = await core.readNamespacedPodLog(
      podName,
      this.namespace,
      container,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      200,
    );
    return res.body || '';
  }

  private async deleteIgnoringNotFound(
    fn: () => Promise<unknown>,
    label: string,
    errors: string[],
  ): Promise<void> {
    try {
      await fn();
    } catch (error) {
      if (this.statusCode(error) === 404) return;
      errors.push(`Failed to delete ${label}: ${this.errorMessage(error)}`);
    }
  }

  private statusCode(error: unknown): number | undefined {
    if (error instanceof HttpError) return error.statusCode;
    const candidate = error as {
      code?: number;
      statusCode?: number;
      response?: { statusCode?: number };
    };
    return candidate?.statusCode ?? candidate?.code ?? candidate?.response?.statusCode;
  }

  /**
   * Human-readable error message for logs.
   *
   * `@kubernetes/client-node`'s `HttpError` (thrown for every non-2xx API
   * response) always carries the same useless `.message`: "HTTP request
   * failed" (see the class's constructor - it hardcodes that string). The
   * actual reason (a 401/403/404/409/422/... and the API server's message)
   * lives on `.statusCode` and `.body`, which nothing here logged before this
   * fix - production diagnosis of "HTTP request failed" therefore always
   * dead-ended. For an HttpError, surface `statusCode` and a capped,
   * JSON-stringified snippet of `body` instead of the generic message. Never
   * logs Secret contents: `.body` is the K8s API SERVER's error response
   * (typically a `Status` object - message/reason/code), not anything we
   * sent, and is capped anyway as a defensive limit.
   */
  private errorMessage(error: unknown): string {
    if (error instanceof HttpError) {
      const bodySnippet = this.stringifyBodySnippet(error.body);
      const detail = bodySnippet ? `: ${bodySnippet}` : '';
      return `HttpError (status ${error.statusCode ?? 'unknown'})${detail}`;
    }
    return error instanceof Error ? error.message : String(error);
  }

  /** JSON-stringify and cap at ~500 chars, for safe inclusion in a log line. */
  private stringifyBodySnippet(body: unknown): string {
    if (body === undefined || body === null) return '';
    let json: string;
    try {
      json = typeof body === 'string' ? body : JSON.stringify(body);
    } catch {
      return '';
    }
    const MAX_CHARS = 500;
    return json.length > MAX_CHARS ? `${json.slice(0, MAX_CHARS)}…(truncated)` : json;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
