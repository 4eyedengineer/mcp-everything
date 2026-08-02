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
   * Image reference as returned by ContainerRegistryService.buildAndPush,
   * which ALREADY includes a tag (e.g. `ghcr.io/owner/repo/srv-abc:latest`).
   * See resolveImageRef() for why `imageTag` is not blindly appended.
   */
  dockerImage: string;
  imageTag?: string;
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

/**
 * `buildAndPush` returns a ref that already carries a tag, but callers also
 * pass an `imageTag` around. Naively doing `${dockerImage}:${imageTag}` (what
 * the old YAML generator did) produced `ghcr.io/o/r/srv:latest:latest`, an
 * invalid reference that would have made every pod ImagePullBackOff. Only
 * append a tag when the ref does not already have one.
 *
 * The `lastIndexOf('/')` guard is what stops a registry host port
 * (`localhost:5000/srv`) from being mistaken for a tag.
 */
export function resolveImageRef(dockerImage: string, imageTag?: string): string {
  const lastSlash = dockerImage.lastIndexOf('/');
  const lastSegment = lastSlash === -1 ? dockerImage : dockerImage.slice(lastSlash + 1);

  // Already tagged (or digest-pinned) - use verbatim.
  if (lastSegment.includes(':') || lastSegment.includes('@')) {
    return dockerImage;
  }

  return `${dockerImage}:${imageTag || 'latest'}`;
}

@Injectable()
export class ManifestGeneratorService {
  private readonly defaultResources: Required<HostedServerResources> = {
    cpuRequest: '100m',
    cpuLimit: '500m',
    memoryRequest: '128Mi',
    memoryLimit: '256Mi',
  };
  private readonly localDomain = 'mcp.localhost';

  constructor(private readonly configService: ConfigService) {}

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

  buildDeployment(spec: HostedServerSpec): V1Deployment {
    const resources = { ...this.defaultResources, ...spec.resources };
    const name = objectNameFor(spec.serverId);
    const hasEnvVars = Object.keys(spec.envVars || {}).length > 0;

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
              runAsUser: 1001,
              runAsGroup: 1001,
              fsGroup: 1001,
              seccompProfile: { type: 'RuntimeDefault' },
            },
            containers: [
              {
                name: 'mcp-server',
                image: resolveImageRef(spec.dockerImage, spec.imageTag),
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
                  runAsUser: 1001,
                  allowPrivilegeEscalation: false,
                  // Generated servers are stateless HTTP processes; the only
                  // thing the Node runtime reliably needs to write is /tmp,
                  // which gets an emptyDir below.
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ['ALL'] },
                },
                volumeMounts: [{ name: 'tmp', mountPath: '/tmp' }],
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
            volumes: [{ name: 'tmp', emptyDir: {} }],
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
