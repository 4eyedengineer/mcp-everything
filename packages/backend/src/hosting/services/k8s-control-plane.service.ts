import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AppsV1Api,
  CoreV1Api,
  HttpError,
  KubeConfig,
  PatchUtils,
  V1Deployment,
  V1Pod,
} from '@kubernetes/client-node';
import {
  HostedServerSpec,
  ManifestGeneratorService,
  MCP_SERVER_APP_LABEL,
  MCP_SERVER_ID_LABEL,
  objectNameFor,
  secretNameFor,
} from './manifest-generator.service';

/**
 * Direct Kubernetes API control plane for hosted MCP servers.
 *
 * Replaces GitOpsService, which committed YAML to a separate `mcp-server-deployments`
 * repo and then reported success. Nothing consumed that repo (the only ArgoCD
 * Application in this cluster points at k8s/overlays/homelab; the ApplicationSet
 * that would have watched server manifests only ever existed as a fenced code
 * block in docs/HOSTING_ARCHITECTURE.md), so "deployed" meant "a git commit
 * succeeded" and nothing more. Talking to the API server directly means a
 * deploy either really created objects or really failed, and deletion really
 * deletes rather than leaving credentials in git history forever.
 *
 * Everything is scoped to one namespace (`mcp-servers`) and the backend's
 * RBAC is a namespaced Role, not a ClusterRole - see k8s/mcp-servers/rbac.yaml.
 */

export type ObservedStatus =
  /** All desired replicas are ready. */
  | 'running'
  /** Rolling out; pods pending, pulling, or starting. */
  | 'progressing'
  /** Deployment exists with spec.replicas === 0. */
  | 'stopped'
  /** Serving, but not at full desired replica count. */
  | 'degraded'
  /** Pods cannot start: ImagePullBackOff, CrashLoopBackOff, OOMKilled, ... */
  | 'failed'
  /** No Deployment with this server-id exists in the cluster. */
  | 'missing'
  /** The cluster could not be reached, or no kubeconfig is available. */
  | 'unknown';

export interface ObservedState {
  serverId: string;
  status: ObservedStatus;
  /** Human-readable reason, e.g. "CrashLoopBackOff: back-off restarting ...". */
  message: string;
  /** Deployment spec.replicas - what the cluster has been asked for. */
  replicas: number;
  /** Deployment status.readyReplicas - what is actually serving. */
  readyReplicas: number;
  observedAt: Date;
}

/**
 * Container waiting/terminated reasons that mean "this will not start on its
 * own" rather than "still starting". Anything here maps to 'failed' and is
 * surfaced verbatim to the user, because these are the reasons an operator
 * actually needs to see.
 */
const FATAL_WAITING_REASONS = new Set([
  'ImagePullBackOff',
  'ErrImagePull',
  'InvalidImageName',
  'CrashLoopBackOff',
  'CreateContainerConfigError',
  'CreateContainerError',
  'RunContainerError',
]);

const FATAL_TERMINATED_REASONS = new Set(['OOMKilled', 'Error', 'ContainerCannotRun']);

@Injectable()
export class K8sControlPlaneService {
  private readonly logger = new Logger(K8sControlPlaneService.name);
  private readonly fieldManager = 'mcp-everything-control-plane';

  readonly namespace: string;
  private readonly imagePullSecretName?: string;

  private appsApi: AppsV1Api | null = null;
  private coreApi: CoreV1Api | null = null;
  private initError: string | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly manifestGenerator: ManifestGeneratorService,
  ) {
    this.namespace = this.configService.get<string>('K8S_NAMESPACE', 'mcp-servers');
    this.imagePullSecretName = this.configService.get<string>('K8S_IMAGE_PULL_SECRET');
    this.initClients();
  }

  /**
   * Loads a kubeconfig if one is reachable. Deliberately non-fatal: the
   * backend must still boot on a dev machine with no cluster and no
   * ~/.kube/config (and in HOSTING_MODE=docker-run, where it never talks to
   * Kubernetes at all). Failures surface per-call instead, via isEnabled().
   *
   * loadFromDefault() already handles the in-cluster case (service account
   * token + KUBERNETES_SERVICE_HOST) as its final fallback, so no explicit
   * in-cluster branch is needed.
   */
  private initClients(): void {
    try {
      const kubeConfig = new KubeConfig();
      kubeConfig.loadFromDefault();
      this.appsApi = kubeConfig.makeApiClient(AppsV1Api);
      this.coreApi = kubeConfig.makeApiClient(CoreV1Api);
      this.logger.log(
        `Kubernetes control plane initialized for namespace '${this.namespace}' ` +
          `(context: ${kubeConfig.getCurrentContext() || 'unknown'})`,
      );
    } catch (error) {
      this.initError = error instanceof Error ? error.message : 'Unknown error';
      this.appsApi = null;
      this.coreApi = null;
      this.logger.warn(
        `No usable Kubernetes configuration (${this.initError}). ` +
          'Kubernetes hosting is unavailable; docker-run hosting is unaffected.',
      );
    }
  }

  isEnabled(): boolean {
    return this.appsApi !== null && this.coreApi !== null;
  }

  private requireApis(): { apps: AppsV1Api; core: CoreV1Api } {
    if (!this.appsApi || !this.coreApi) {
      throw new Error(
        `Kubernetes control plane is not available${this.initError ? `: ${this.initError}` : ''}. ` +
          'Set a valid KUBECONFIG, run in-cluster, or use HOSTING_MODE=docker-run.',
      );
    }
    return { apps: this.appsApi, core: this.coreApi };
  }

  /**
   * Create-or-update a server's Secret, Deployment and Service.
   *
   * Uses Server-Side Apply for all three: one call per object that both
   * creates and updates, with the API server doing field-level conflict
   * resolution against our field manager. This is what replaces the old
   * getRef -> getCommit -> createTree -> createCommit -> updateRef sequence,
   * which had no conflict handling at all and would 422 whenever two deploys
   * raced.
   *
   * Secret first, so the Deployment's envFrom reference never points at a
   * Secret that does not exist yet.
   */
  async applyServer(spec: Omit<HostedServerSpec, 'namespace'>): Promise<void> {
    const { apps, core } = this.requireApis();
    const fullSpec: HostedServerSpec = {
      ...spec,
      namespace: this.namespace,
      imagePullSecretName: spec.imagePullSecretName ?? this.imagePullSecretName,
    };

    const { deployment, service, secret } = this.manifestGenerator.buildAll(fullSpec);

    if (secret) {
      await core.patchNamespacedSecret(
        secretNameFor(spec.serverId),
        this.namespace,
        secret,
        undefined, // pretty
        undefined, // dryRun
        this.fieldManager,
        undefined, // fieldValidation
        true, // force - reclaim fields previously owned by another manager
        this.applyOptions(),
      );
    }

    await apps.patchNamespacedDeployment(
      objectNameFor(spec.serverId),
      this.namespace,
      deployment,
      undefined,
      undefined,
      this.fieldManager,
      undefined,
      true,
      this.applyOptions(),
    );

    await core.patchNamespacedService(
      objectNameFor(spec.serverId),
      this.namespace,
      service,
      undefined,
      undefined,
      this.fieldManager,
      undefined,
      true,
      this.applyOptions(),
    );

    this.logger.log(
      `Applied Deployment/Service${secret ? '/Secret' : ''} for ${spec.serverId} in ${this.namespace}`,
    );
  }

  /** Scale a server's Deployment. 0 = stopped, 1 = running. */
  async scaleServer(serverId: string, replicas: number): Promise<void> {
    const { apps } = this.requireApis();

    await apps.patchNamespacedDeployment(
      objectNameFor(serverId),
      this.namespace,
      { spec: { replicas } },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': PatchUtils.PATCH_FORMAT_JSON_MERGE_PATCH } },
    );

    this.logger.log(`Scaled ${objectNameFor(serverId)} to ${replicas} replica(s)`);
  }

  /**
   * Delete every object belonging to a server. Idempotent: a 404 on any object
   * means it is already gone, which is the desired end state.
   *
   * Unlike the GitOps path this is a real deletion. That mattered for more
   * than tidiness - the old flow committed manifests to git, so "deleting" a
   * server left it recoverable in history forever, which is the wrong
   * behaviour for account deletion and for anything holding user credentials.
   */
  async deleteServer(serverId: string): Promise<void> {
    const { apps, core } = this.requireApis();
    const name = objectNameFor(serverId);

    // propagationPolicy=Background is explicit on purpose. Deleting a
    // Deployment without it can leave the ReplicaSet - and therefore the
    // pods - orphaned and still running, i.e. "deleted" servers that are
    // still serving traffic and still burning namespace quota. kubectl always
    // sets a policy; the raw API client does not.
    await this.ignoreNotFound(() =>
      apps.deleteNamespacedDeployment(
        name,
        this.namespace,
        undefined, // pretty
        undefined, // dryRun
        undefined, // gracePeriodSeconds
        undefined, // orphanDependents
        'Background',
      ),
    );
    await this.ignoreNotFound(() => core.deleteNamespacedService(name, this.namespace));
    await this.ignoreNotFound(() =>
      core.deleteNamespacedSecret(secretNameFor(serverId), this.namespace),
    );

    this.logger.log(`Deleted Kubernetes objects for ${serverId} from ${this.namespace}`);
  }

  /**
   * Observed state for a single server. Used for on-demand reads; the
   * reconciler uses observeAll() instead, which is 2 API calls for every
   * server rather than 2 per server.
   */
  async getObservedState(serverId: string): Promise<ObservedState> {
    if (!this.isEnabled()) {
      return this.unknownState(serverId, 'No Kubernetes configuration available');
    }

    const { apps, core } = this.requireApis();

    let deployment: V1Deployment;
    try {
      const response = await apps.readNamespacedDeployment(
        objectNameFor(serverId),
        this.namespace,
      );
      deployment = response.body;
    } catch (error) {
      if (this.statusCode(error) === 404) {
        return {
          serverId,
          status: 'missing',
          message: `No Deployment ${objectNameFor(serverId)} in namespace ${this.namespace}`,
          replicas: 0,
          readyReplicas: 0,
          observedAt: new Date(),
        };
      }
      return this.unknownState(serverId, this.errorMessage(error));
    }

    let pods: V1Pod[] = [];
    try {
      const podList = await this.listPods(core, `${MCP_SERVER_ID_LABEL}=${serverId}`);
      pods = podList.items || [];
    } catch (error) {
      // Deployment status alone is still a useful answer; note the gap.
      this.logger.warn(`Could not list pods for ${serverId}: ${this.errorMessage(error)}`);
    }

    return this.deriveObservedState(serverId, deployment, pods);
  }

  /**
   * Observed state for every server the control plane manages, in two API
   * calls total (one Deployment list, one Pod list), both filtered by
   * `app=mcp-server`. Returned keyed by serverId.
   */
  async observeAll(): Promise<Map<string, ObservedState>> {
    const { apps, core } = this.requireApis();
    const selector = `app=${MCP_SERVER_APP_LABEL}`;

    const [deploymentList, podList] = await Promise.all([
      this.listDeployments(apps, selector),
      this.listPods(core, selector),
    ]);

    const podsByServerId = new Map<string, V1Pod[]>();
    for (const pod of podList.items || []) {
      const serverId = pod.metadata?.labels?.[MCP_SERVER_ID_LABEL];
      if (!serverId) continue;
      const existing = podsByServerId.get(serverId);
      if (existing) {
        existing.push(pod);
      } else {
        podsByServerId.set(serverId, [pod]);
      }
    }

    const result = new Map<string, ObservedState>();
    for (const deployment of deploymentList.items || []) {
      const serverId = deployment.metadata?.labels?.[MCP_SERVER_ID_LABEL];
      if (!serverId) continue;
      result.set(
        serverId,
        this.deriveObservedState(serverId, deployment, podsByServerId.get(serverId) || []),
      );
    }

    return result;
  }

  /**
   * Map a Deployment plus its pods onto an observed status.
   *
   * Ordering matters and is deliberate:
   *  1. spec.replicas === 0 is 'stopped' regardless of what leftover pods say.
   *  2. A fatal pod reason (ImagePullBackOff / CrashLoopBackOff / OOMKilled)
   *     beats "still progressing" - a CrashLooping pod is never going to
   *     become ready on its own, and reporting it as 'progressing' forever is
   *     exactly the bug this replaces.
   *  3. Only then do ready-replica counts decide running/degraded/progressing.
   */
  deriveObservedState(serverId: string, deployment: V1Deployment, pods: V1Pod[]): ObservedState {
    const observedAt = new Date();
    const desiredReplicas = deployment.spec?.replicas ?? 0;
    const readyReplicas = deployment.status?.readyReplicas ?? 0;

    if (desiredReplicas === 0) {
      return {
        serverId,
        status: 'stopped',
        message: 'Scaled to 0 replicas',
        replicas: 0,
        readyReplicas: 0,
        observedAt,
      };
    }

    const failure = this.findPodFailure(pods);
    if (failure) {
      return {
        serverId,
        status: 'failed',
        message: failure,
        replicas: desiredReplicas,
        readyReplicas,
        observedAt,
      };
    }

    if (readyReplicas >= desiredReplicas) {
      return {
        serverId,
        status: 'running',
        message: `${readyReplicas}/${desiredReplicas} replica(s) ready`,
        replicas: desiredReplicas,
        readyReplicas,
        observedAt,
      };
    }

    if (readyReplicas > 0) {
      return {
        serverId,
        status: 'degraded',
        message: `Only ${readyReplicas}/${desiredReplicas} replica(s) ready`,
        replicas: desiredReplicas,
        readyReplicas,
        observedAt,
      };
    }

    return {
      serverId,
      status: 'progressing',
      message: this.progressMessage(deployment, pods, desiredReplicas),
      replicas: desiredReplicas,
      readyReplicas,
      observedAt,
    };
  }

  /**
   * First fatal container condition across a server's pods, formatted as
   * "<Reason>: <message>". OOMKilled is checked in lastState as well as
   * state, because a pod that was OOM-killed and restarted reports the kill
   * only in lastState.terminated while state shows a fresh running container.
   */
  private findPodFailure(pods: V1Pod[]): string | null {
    for (const pod of pods) {
      const statuses = [
        ...(pod.status?.containerStatuses || []),
        ...(pod.status?.initContainerStatuses || []),
      ];

      for (const status of statuses) {
        const waiting = status.state?.waiting;
        if (waiting?.reason && FATAL_WAITING_REASONS.has(waiting.reason)) {
          return `${waiting.reason}: ${waiting.message || 'no further detail from kubelet'}`;
        }

        const terminated = status.state?.terminated;
        if (terminated?.reason && FATAL_TERMINATED_REASONS.has(terminated.reason)) {
          return `${terminated.reason}: ${terminated.message || `container exited with code ${terminated.exitCode ?? 'unknown'}`}`;
        }

        const lastTerminated = status.lastState?.terminated;
        if (lastTerminated?.reason === 'OOMKilled') {
          return `OOMKilled: container exceeded its memory limit and was killed (restartCount=${status.restartCount ?? 0})`;
        }
      }

      if (pod.status?.phase === 'Failed') {
        return `Pod failed: ${pod.status?.reason || 'no reason reported'}${
          pod.status?.message ? ` - ${pod.status.message}` : ''
        }`;
      }
    }

    return null;
  }

  /** Best-effort detail for why a server is not ready yet. */
  private progressMessage(
    deployment: V1Deployment,
    pods: V1Pod[],
    desiredReplicas: number,
  ): string {
    for (const pod of pods) {
      const waiting = (pod.status?.containerStatuses || []).find((s) => s.state?.waiting)?.state
        ?.waiting;
      if (waiting?.reason) {
        return `${waiting.reason}: ${waiting.message || 'container is starting'}`;
      }
    }

    const progressing = (deployment.status?.conditions || []).find(
      (c) => c.type === 'Progressing' || c.type === 'Available',
    );
    if (progressing?.message) {
      return progressing.message;
    }

    return pods.length === 0
      ? `Waiting for ${desiredReplicas} pod(s) to be scheduled`
      : `0/${desiredReplicas} replica(s) ready`;
  }

  /**
   * Tail a server's pod logs. Picks the newest pod so that after a rollout the
   * user sees the current one rather than a terminating predecessor.
   */
  async getLogs(serverId: string, lines = 100): Promise<string[]> {
    const { core } = this.requireApis();

    const podList = await this.listPods(core, `${MCP_SERVER_ID_LABEL}=${serverId}`);

    const pods = [...(podList.items || [])].sort((a, b) => {
      const aTime = new Date(a.metadata?.creationTimestamp || 0).getTime();
      const bTime = new Date(b.metadata?.creationTimestamp || 0).getTime();
      return bTime - aTime;
    });

    const podName = pods[0]?.metadata?.name;
    if (!podName) {
      return [];
    }

    const response = await core.readNamespacedPodLog(
      podName,
      this.namespace,
      'mcp-server',
      undefined, // follow
      undefined, // insecureSkipTLSVerifyBackend
      undefined, // limitBytes
      undefined, // pretty
      undefined, // previous
      undefined, // sinceSeconds
      lines,
    );

    return (response.body || '').split('\n').filter((line) => line.length > 0);
  }

  // --- helpers ---

  /**
   * Server-Side Apply content type. The 0.x client takes request options as a
   * trailing positional argument rather than a helper, hence the explicit
   * header.
   */
  private applyOptions() {
    return { headers: { 'Content-Type': PatchUtils.PATCH_FORMAT_APPLY_YAML } };
  }

  /**
   * Wrappers for the two list calls. The 0.x client is positional with a long
   * tail of optional parameters, so `labelSelector` sits in the 6th slot;
   * naming it once here keeps that off every call site.
   */
  private async listDeployments(apps: AppsV1Api, labelSelector: string) {
    const response = await apps.listNamespacedDeployment(
      this.namespace,
      undefined, // pretty
      undefined, // allowWatchBookmarks
      undefined, // _continue
      undefined, // fieldSelector
      labelSelector,
    );
    return response.body;
  }

  private async listPods(core: CoreV1Api, labelSelector: string) {
    const response = await core.listNamespacedPod(
      this.namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      labelSelector,
    );
    return response.body;
  }

  private async ignoreNotFound(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      if (this.statusCode(error) === 404) {
        return;
      }
      throw error;
    }
  }

  private statusCode(error: unknown): number | undefined {
    if (error instanceof HttpError) {
      return error.statusCode;
    }
    // Defensive: mocked clients and other shapes surface the status elsewhere.
    const candidate = error as {
      code?: number;
      statusCode?: number;
      response?: { statusCode?: number };
    };
    return candidate?.statusCode ?? candidate?.code ?? candidate?.response?.statusCode;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private unknownState(serverId: string, message: string): ObservedState {
    return {
      serverId,
      status: 'unknown',
      message,
      replicas: 0,
      readyReplicas: 0,
      observedAt: new Date(),
    };
  }
}
