import { Injectable } from '@nestjs/common';
import * as yaml from 'js-yaml';

export interface ManifestConfig {
  serverId: string;
  serverName: string;
  dockerImage: string;
  imageTag: string;
  domain: string; // e.g., mcp.yourdomain.com
  namespace: string;
  resources?: {
    cpuRequest?: string;
    cpuLimit?: string;
    memoryRequest?: string;
    memoryLimit?: string;
  };
  envVars?: Record<string, string>;
}

export interface GeneratedManifests {
  deployment: string;
  service: string;
  ingress: string;
}

@Injectable()
export class ManifestGeneratorService {
  private readonly defaultResources = {
    cpuRequest: '100m',
    cpuLimit: '500m',
    memoryRequest: '128Mi',
    memoryLimit: '256Mi',
  };

  /**
   * Generate all K8s manifests for an MCP server
   */
  generateManifests(config: ManifestConfig): GeneratedManifests {
    return {
      deployment: this.generateDeployment(config),
      service: this.generateService(config),
      ingress: this.generateIngress(config),
    };
  }

  private generateDeployment(config: ManifestConfig): string {
    const resources = { ...this.defaultResources, ...config.resources };

    const deployment = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: `mcp-${config.serverId}`,
        namespace: config.namespace,
        labels: {
          app: 'mcp-server',
          'server-id': config.serverId,
          'server-name': config.serverName,
        },
      },
      spec: {
        replicas: 1,
        selector: {
          matchLabels: {
            app: 'mcp-server',
            'server-id': config.serverId,
          },
        },
        template: {
          metadata: {
            labels: {
              app: 'mcp-server',
              'server-id': config.serverId,
            },
          },
          spec: {
            containers: [
              {
                name: 'mcp-server',
                image: `${config.dockerImage}:${config.imageTag}`,
                ports: [{ containerPort: 3000 }],
                resources: {
                  requests: {
                    cpu: resources.cpuRequest,
                    memory: resources.memoryRequest,
                  },
                  limits: {
                    cpu: resources.cpuLimit,
                    memory: resources.memoryLimit,
                  },
                },
                env: [
                  { name: 'MCP_SERVER_ID', value: config.serverId },
                  { name: 'PORT', value: '3000' },
                  ...Object.entries(config.envVars || {}).map(([name, value]) => ({
                    name,
                    value,
                  })),
                ],
                livenessProbe: {
                  httpGet: { path: '/health', port: 3000 },
                  initialDelaySeconds: 10,
                  periodSeconds: 30,
                },
                readinessProbe: {
                  httpGet: { path: '/health', port: 3000 },
                  initialDelaySeconds: 5,
                  periodSeconds: 10,
                },
              },
            ],
          },
        },
      },
    };

    return yaml.dump(deployment);
  }

  private generateService(config: ManifestConfig): string {
    const service = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: `mcp-${config.serverId}`,
        namespace: config.namespace,
        labels: {
          app: 'mcp-server',
          'server-id': config.serverId,
        },
      },
      spec: {
        selector: {
          app: 'mcp-server',
          'server-id': config.serverId,
        },
        ports: [
          {
            port: 80,
            targetPort: 3000,
            protocol: 'TCP',
          },
        ],
      },
    };

    return yaml.dump(service);
  }

  private generateIngress(config: ManifestConfig): string {
    const host = `${config.serverId}.${config.domain}`;

    const ingress = {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'Ingress',
      metadata: {
        name: `mcp-${config.serverId}`,
        namespace: config.namespace,
        labels: {
          app: 'mcp-server',
          'server-id': config.serverId,
        },
        annotations: {
          'kubernetes.io/ingress.class': 'nginx',
          'cert-manager.io/cluster-issuer': 'letsencrypt-prod',
          'nginx.ingress.kubernetes.io/proxy-read-timeout': '300',
          'nginx.ingress.kubernetes.io/proxy-send-timeout': '300',
        },
      },
      spec: {
        tls: [
          {
            hosts: [host],
            secretName: `mcp-${config.serverId}-tls`,
          },
        ],
        rules: [
          {
            host,
            http: {
              paths: [
                {
                  path: '/',
                  pathType: 'Prefix',
                  backend: {
                    service: {
                      name: `mcp-${config.serverId}`,
                      port: { number: 80 },
                    },
                  },
                },
              ],
            },
          },
        ],
      },
    };

    return yaml.dump(ingress);
  }

  /**
   * Generate kustomization.yaml for the server directory
   */
  generateKustomization(serverId: string): string {
    const kustomization = {
      apiVersion: 'kustomize.config.k8s.io/v1beta1',
      kind: 'Kustomization',
      resources: ['deployment.yaml', 'service.yaml', 'ingress.yaml'],
      commonLabels: {
        'managed-by': 'mcp-everything',
        'server-id': serverId,
      },
    };

    return yaml.dump(kustomization);
  }
}
