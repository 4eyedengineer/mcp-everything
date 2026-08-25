import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { V1Deployment, V1Secret, V1Service } from '@kubernetes/client-node';

/**
 * Single source of truth for what a hosted MCP server looks like in
 * Kubernetes.
 *
 * This used to emit YAML strings, because its only consumer was GitOpsService
 * committing files to a git repo that nothing ever consumed. That path is
 * gone: K8sControlPlaneService talks to the Kubernetes API directly and needs
 * typed objects, so these builders now return the same `V1*` types the API
 * client accepts. Nothing here serialises to YAML any more - there is exactly
 * one definition of a hosted server's Deployment, and it lives in this file.
 *
 * Two deliberate omissions:
 *
 * 1. No Ingress. Per-server Ingress (plus the wildcard DNS and cert-manager
 *    certificate it would need) is deferred pending a decision to route hosted
 *    traffic through a backend gateway on a single public origin instead. Only
 *    a ClusterIP Service is emitted; the RBAC in k8s/mcp-servers/rbac.yaml
 *    deliberately grants no Ingress permission at all.
 * 2. No Kustomization. That existed only so ArgoCD could pick up a committed
 *    directory.
 */

/** Port the generated MCP servers listen on when MCP_TRANSPORT=http. */
export const MCP_CONTAINER_PORT = 3000;

/**
 * Shared runner image used for BOTH containers of every hosted server. There
 * are no per-server images any more; see packages/mcp-runner/README.md.
 *
 * Overridable with MCP_RUNNER_IMAGE so a cluster can pin an immutable
 * `:<sha>` tag (which is what a production deployment should do) without a
 * code change. Defined once here rather than inlined at each use site.
 */
export const DEFAULT_MCP_RUNNER_IMAGE =
  'harbor.192.168.1.240.nip.io/mcp-everything/mcp-runner:latest';

/** initContainer name - `kubectl logs <pod> -c mcp-runner-init` is the docs' advice. */
export const MCP_INIT_CONTAINER_NAME = 'mcp-runner-init';

/** Main (serving) container name. */
export const MCP_MAIN_CONTAINER_NAME = 'mcp-server';

/** emptyDir shared between the init and main containers. */
export const MCP_APP_VOLUME_NAME = 'app';

/** Where that emptyDir is mounted in both containers. */
export const MCP_APP_MOUNT_PATH = '/app';

/**
 * uid/gid the runner image runs as (`USER 1000:1000`). fsGroup MUST match it:
 * Kubernetes does not apply an image's directory ownership to a mounted
 * emptyDir, so without this the initContainer dies immediately on its own
 * writability check. See packages/mcp-runner/README.md.
 */
export const MCP_RUNNER_UID = 1000;

/**
 * The two env vars the initContainer needs to fetch its own source. They are
 * minted per-deploy by HostingService and land in the same Secret as the
 * user's env vars, so they are projected by secretKeyRef rather than inlined.
 */
export const MCP_SOURCE_URL_ENV = 'MCP_SOURCE_URL';
export const MCP_SOURCE_TOKEN_ENV = 'MCP_SOURCE_TOKEN';
export const MCP_SOURCE_ENV_VARS = [MCP_SOURCE_URL_ENV, MCP_SOURCE_TOKEN_ENV] as const;

/** Port the per-server ClusterIP Service exposes. */
export const MCP_SERVICE_PORT = 80;

/**
 * Label applied to every object this service builds. The reconciler lists by
 * this selector, and the NetworkPolicy in k8s/mcp-servers/network-policy.yaml
 * selects pods with it.
 */
export const MCP_SERVER_APP_LABEL = 'mcp-server';

/** `metadata.labels['server-id']` - how an object is traced back to a row. */
export const MCP_SERVER_ID_LABEL = 'server-id';

export interface HostedServerResources {
  cpuRequest?: string;
  cpuLimit?: string;
  memoryRequest?: string;
  memoryLimit?: string;
}

export interface HostedServerSpec {
  serverId: string;
  serverName: string;
  /**
   * Override for the shared runner image. Almost never set: the value comes
   * from MCP_RUNNER_IMAGE (or DEFAULT_MCP_RUNNER_IMAGE). There is deliberately
   * no per-server image field - the backend pod cannot build one.
   */
  runnerImage?: string;
  namespace: string;
  replicas?: number;
  resources?: HostedServerResources;
  /**
   * User-supplied env vars. These NEVER appear in the Deployment as literal
   * `value:` entries - buildSecret() puts them in a Secret and the Deployment
   * references it via envFrom.secretRef.
   */
  envVars?: Record<string, string>;
  imagePullSecretName?: string;
  serviceAccountName?: string;
  /**
   * Resources for the initContainer, which is the expensive one: it runs
   * `npm install` and `tsc`. Defaults are deliberately larger than the serving
   * container's - a 256Mi cap OOM-kills the TypeScript compiler.
   */
  initResources?: HostedServerResources;
}

export interface HostedServerObjects {
  deployment: V1Deployment;
  service: V1Service;
  /** Undefined when the server has no user-supplied env vars. */
  secret?: V1Secret;
}

/** Deployment/Service object name for a server. */
export function objectNameFor(serverId: string): string {
  return `mcp-${serverId}`;
}

/** Name of the Secret holding a server's user-supplied env vars. */
export function secretNameFor(serverId: string): string {
  return `mcp-${serverId}-env`;
}

@Injectable()
export class ManifestGeneratorService {
  private readonly defaultResources: Required<HostedServerResources> = {
    cpuRequest: '100m',
    cpuLimit: '500m',
    memoryRequest: '128Mi',
    memoryLimit: '256Mi',
  };

  /**
   * The initContainer compiles the server with `tsc`, which is both the
   * slowest phase of cold start and by far the most memory-hungry thing in the
   * pod. Giving it the serving container's 256Mi limit gets it OOMKilled, so it
   * gets its own, larger budget. These are limits on a short-lived container,
   * not a standing reservation.
   */
  private readonly defaultInitResources: Required<HostedServerResources> = {
    cpuRequest: '250m',
    cpuLimit: '1000m',
    memoryRequest: '256Mi',
    memoryLimit: '768Mi',
  };

  private readonly localDomain = 'mcp.localhost';
  private readonly runnerImage: string;

  constructor(private readonly configService: ConfigService) {
    this.runnerImage = this.configService.get<string>(
      'MCP_RUNNER_IMAGE',
      DEFAULT_MCP_RUNNER_IMAGE,
    );
  }

  /** The shared runner image this cluster is configured to use. */
  resolveRunnerImage(spec?: Pick<HostedServerSpec, 'runnerImage'>): string {
    return spec?.runnerImage || this.runnerImage;
  }

  private isLocalDev(): boolean {
    return this.configService.get<string>('LOCAL_DEV') === 'true';
  }

  /**
   * Domain used to compose a hosted server's advertised endpoint URL. Kept
   * even though no Ingress is generated - HostingService still records an
   * endpointUrl per server, and whatever gateway ends up fronting these will
   * be rooted at this domain.
   */
  getDomain(): string {
    if (this.isLocalDev()) {
      return this.localDomain;
    }
    return this.configService.get<string>('MCP_HOSTING_DOMAIN', 'mcp.example.com');
  }

  /** Labels every object for a server carries. */
  labelsFor(spec: Pick<HostedServerSpec, 'serverId'>): Record<string, string> {
    return {
      app: MCP_SERVER_APP_LABEL,
      [MCP_SERVER_ID_LABEL]: spec.serverId,
      'app.kubernetes.io/managed-by': 'mcp-everything',
    };
  }

  /** Selector matching exactly one server's pods. */
  selectorFor(serverId: string): Record<string, string> {
    return {
      app: MCP_SERVER_APP_LABEL,
      [MCP_SERVER_ID_LABEL]: serverId,
    };
  }

  buildAll(spec: HostedServerSpec): HostedServerObjects {
    return {
      deployment: this.buildDeployment(spec),
      service: this.buildService(spec),
      secret: this.buildSecret(spec),
    };
  }

  /**
   * A hosted server's Deployment.
   *
   * Shape note, because it is unusual and load-bearing: there is NO per-server
   * image. Both containers run the same shared `mcp-runner` image over one
   * `emptyDir` at /app -
   *
   *   initContainer `mcp-runner-init`  fetch source tarball -> npm install -> tsc
   *   container     `mcp-server`       node dist/index.js (MCP_TRANSPORT=http)
   *
   * The backend pod has no docker binary and no docker socket, so it cannot
   * build a per-server image; the build moved into the pod that will run the
   * server. This also removes an architecture trap - one multi-arch runner
   * schedules anywhere on a mixed amd64/arm64 cluster, where a single-arch
   * per-server image would ImagePullBackOff on most nodes.
   *
   * The `/health` probes stay on the main container and are unchanged: the
   * initContainer gates startup, so nothing probes until the build is done and
   * no probe timing needs to absorb the ~30s compile.
   */
  buildDeployment(spec: HostedServerSpec): V1Deployment {
    const resources = { ...this.defaultResources, ...spec.resources };
    const initResources = { ...this.defaultInitResources, ...spec.initResources };
    const name = objectNameFor(spec.serverId);
    const envVars = spec.envVars || {};
    const hasEnvVars = Object.keys(envVars).length > 0;
    const runnerImage = this.resolveRunnerImage(spec);
    const secretName = secretNameFor(spec.serverId);

    // Only the two source vars reach the initContainer, and only by reference.
    // Projecting the whole Secret with envFrom would hand the build step every
    // credential the user configured for their server, which it has no use for.
    // Gated on actual presence so a spec without them produces a Deployment
    // that fails with the runner's own explicit "MCP_SOURCE_URL is not set"
    // message rather than a dangling secretKeyRef.
    const sourceEnv = MCP_SOURCE_ENV_VARS.filter((key) => key in envVars).map((key) => ({
      name: key,
      valueFrom: { secretKeyRef: { name: secretName, key, optional: false } },
    }));

    return {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name,
        namespace: spec.namespace,
        labels: {
          ...this.labelsFor(spec),
          // Not a selector label: server names are user-supplied and need not
          // be valid label values, so this is best-effort metadata only.
          'server-name': sanitizeLabelValue(spec.serverName),
        },
      },
      spec: {
        replicas: spec.replicas ?? 1,
        selector: { matchLabels: this.selectorFor(spec.serverId) },
        template: {
          metadata: { labels: this.selectorFor(spec.serverId) },
          spec: {
            // A hosted MCP server is arbitrary AI-generated third-party code.
            // It gets a dedicated ServiceAccount that is bound to nothing, and
            // no API token is projected into it. The pod-level setting is what
            // actually takes effect, which is why it is repeated here rather
            // than left to the ServiceAccount object alone.
            serviceAccountName: spec.serviceAccountName || 'mcp-server-runtime',
            automountServiceAccountToken: false,
            ...(spec.imagePullSecretName
              ? { imagePullSecrets: [{ name: spec.imagePullSecretName }] }
              : {}),
            securityContext: {
              runAsNonRoot: true,
              // Must match the runner image's `USER 1000:1000`. fsGroup in
              // particular is not optional: it is what makes the shared
              // emptyDir writable by a non-root process, and without it the
              // initContainer exits immediately on its own write test.
              runAsUser: MCP_RUNNER_UID,
              runAsGroup: MCP_RUNNER_UID,
              fsGroup: MCP_RUNNER_UID,
              seccompProfile: { type: 'RuntimeDefault' },
            },
            initContainers: [
              {
                name: MCP_INIT_CONTAINER_NAME,
                image: runnerImage,
                command: [MCP_INIT_CONTAINER_NAME],
                env: [
                  { name: 'MCP_APP_DIR', value: MCP_APP_MOUNT_PATH },
                  ...sourceEnv,
                ],
                resources: {
                  requests: {
                    cpu: initResources.cpuRequest,
                    memory: initResources.memoryRequest,
                  },
                  limits: { cpu: initResources.cpuLimit, memory: initResources.memoryLimit },
                },
                securityContext: {
                  runAsNonRoot: true,
                  runAsUser: MCP_RUNNER_UID,
                  allowPrivilegeEscalation: false,
                  // The init script keeps every scratch file (and npm's cache,
                  // via npm_config_cache=/app/.npm in the image) under /app,
                  // so nothing outside the shared volume is ever written.
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ['ALL'] },
                },
                volumeMounts: [
                  { name: MCP_APP_VOLUME_NAME, mountPath: MCP_APP_MOUNT_PATH },
                  // The image points npm's cache at /app/.npm, but npm and tsc
                  // both still reach for os.tmpdir() for scratch space, and
                  // readOnlyRootFilesystem makes the image's own /tmp
                  // unwritable. Cheaper to mount than to discover.
                  { name: 'tmp', mountPath: '/tmp' },
                ],
              },
            ],
            containers: [
              {
                name: MCP_MAIN_CONTAINER_NAME,
                image: runnerImage,
                command: ['mcp-runner-serve'],
                ports: [{ name: 'http', containerPort: MCP_CONTAINER_PORT, protocol: 'TCP' }],
                resources: {
                  requests: { cpu: resources.cpuRequest, memory: resources.memoryRequest },
                  limits: { cpu: resources.cpuLimit, memory: resources.memoryLimit },
                },
                // Only non-secret, platform-owned values are inlined here.
                // Everything the user supplied goes through envFrom below.
                env: [
                  { name: 'MCP_SERVER_ID', value: spec.serverId },
                  // Generated servers default to stdio; without this the
                  // container would never open a port and both probes would
                  // fail forever.
                  { name: 'MCP_TRANSPORT', value: 'http' },
                  { name: 'PORT', value: String(MCP_CONTAINER_PORT) },
                ],
                ...(hasEnvVars
                  ? {
                      envFrom: [
                        {
                          secretRef: {
                            name: secretNameFor(spec.serverId),
                            // Fail loudly rather than silently booting a
                            // server without its credentials.
                            optional: false,
                          },
                        },
                      ],
                    }
                  : {}),
                securityContext: {
                  runAsNonRoot: true,
                  runAsUser: MCP_RUNNER_UID,
                  allowPrivilegeEscalation: false,
                  // Generated servers are stateless HTTP processes; the only
                  // things the Node runtime reliably needs to write are /tmp
                  // and the shared /app volume, both emptyDirs below.
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ['ALL'] },
                },
                volumeMounts: [
                  { name: MCP_APP_VOLUME_NAME, mountPath: MCP_APP_MOUNT_PATH },
                  { name: 'tmp', mountPath: '/tmp' },
                ],
                livenessProbe: {
                  httpGet: { path: '/health', port: MCP_CONTAINER_PORT },
                  initialDelaySeconds: 10,
                  periodSeconds: 30,
                },
                readinessProbe: {
                  httpGet: { path: '/health', port: MCP_CONTAINER_PORT },
                  initialDelaySeconds: 5,
                  periodSeconds: 10,
                },
              },
            ],
            volumes: [
              // The whole point of the shape: one volume, written by the init
              // container and read (and run) by the main one.
              { name: MCP_APP_VOLUME_NAME, emptyDir: {} },
              { name: 'tmp', emptyDir: {} },
            ],
          },
        },
      },
    };
  }

  buildService(spec: HostedServerSpec): V1Service {
    return {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: objectNameFor(spec.serverId),
        namespace: spec.namespace,
        labels: this.labelsFor(spec),
      },
      spec: {
        // Explicit: nothing here should ever be exposed directly to the
        // internet. External reachability is the pending gateway's job.
        type: 'ClusterIP',
        selector: this.selectorFor(spec.serverId),
        ports: [
          {
            name: 'http',
            port: MCP_SERVICE_PORT,
            targetPort: MCP_CONTAINER_PORT,
            protocol: 'TCP',
          },
        ],
      },
    };
  }

  /**
   * Returns undefined when there is nothing secret to store, so callers do not
   * create an empty Secret (and the Deployment omits envFrom entirely).
   */
  buildSecret(spec: HostedServerSpec): V1Secret | undefined {
    const envVars = spec.envVars || {};
    if (Object.keys(envVars).length === 0) {
      return undefined;
    }

    return {
      apiVersion: 'v1',
      kind: 'Secret',
      type: 'Opaque',
      metadata: {
        name: secretNameFor(spec.serverId),
        namespace: spec.namespace,
        labels: this.labelsFor(spec),
      },
      // stringData (not data) so values are sent as-is and base64-encoded by
      // the API server - encoding them here would double-encode.
      stringData: { ...envVars },
    };
  }
}

/**
 * Kubernetes label values must be <=63 chars of alphanumerics, '-', '_' or
 * '.', starting and ending alphanumeric. Server names are user-supplied, so an
 * unsanitised one would make the whole Deployment rejected by the API server.
 */
function sanitizeLabelValue(value: string): string {
  const cleaned = (value || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .slice(0, 63)
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9]+$/, '');

  return cleaned || 'unnamed';
}
