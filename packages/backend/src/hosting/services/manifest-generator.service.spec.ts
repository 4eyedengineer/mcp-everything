import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  DEFAULT_MCP_RUNNER_IMAGE,
  HostedServerSpec,
  ManifestGeneratorService,
  MCP_INIT_CONTAINER_NAME,
  objectNameFor,
  secretNameFor,
} from './manifest-generator.service';

describe('ManifestGeneratorService', () => {
  let service: ManifestGeneratorService;

  const baseSpec: HostedServerSpec = {
    serverId: 'stripe-abc123',
    serverName: 'stripe-mcp',
    namespace: 'mcp-servers',
  };

  /** The env shape HostingService always injects for a real deploy. */
  const sourceEnv = {
    MCP_SOURCE_URL: 'http://mcp-backend.mcp-everything.svc.cluster.local:3000/api/hosting/servers/stripe-abc123/source',
    MCP_SOURCE_TOKEN: 'mcpsrc_supersecrettokenvalue',
  };

  async function buildService(config: Record<string, unknown> = {}): Promise<ManifestGeneratorService> {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ManifestGeneratorService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: unknown) =>
              key in config ? config[key] : defaultValue,
            ),
          },
        },
      ],
    }).compile();

    return module.get<ManifestGeneratorService>(ManifestGeneratorService);
  }

  beforeEach(async () => {
    service = await buildService();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('buildAll', () => {
    it('returns a Deployment and Service, and no Secret when there are no env vars', () => {
      const objects = service.buildAll(baseSpec);

      expect(objects.deployment.kind).toBe('Deployment');
      expect(objects.service.kind).toBe('Service');
      expect(objects.secret).toBeUndefined();
    });

    it('never emits an Ingress - per-server ingress is deliberately deferred', () => {
      const objects = service.buildAll(baseSpec) as unknown as Record<string, unknown>;

      expect(objects['ingress']).toBeUndefined();
      expect(Object.keys(objects).sort()).toEqual(['deployment', 'secret', 'service']);
    });
  });

  describe('buildDeployment', () => {
    it('sets identity, namespace and labels', () => {
      const deployment = service.buildDeployment(baseSpec);

      expect(deployment.apiVersion).toBe('apps/v1');
      expect(deployment.metadata?.name).toBe('mcp-stripe-abc123');
      expect(deployment.metadata?.namespace).toBe('mcp-servers');
      expect(deployment.metadata?.labels?.app).toBe('mcp-server');
      expect(deployment.metadata?.labels?.['server-id']).toBe('stripe-abc123');
      expect(deployment.metadata?.labels?.['server-name']).toBe('stripe-mcp');
    });

    it('uses default resource requests/limits', () => {
      const container = service.buildDeployment(baseSpec).spec!.template!.spec!.containers[0];

      expect(container.resources?.requests?.cpu).toBe('100m');
      expect(container.resources?.requests?.memory).toBe('128Mi');
      expect(container.resources?.limits?.cpu).toBe('500m');
      expect(container.resources?.limits?.memory).toBe('256Mi');
    });

    it('allows custom resource requests/limits', () => {
      const container = service.buildDeployment({
        ...baseSpec,
        resources: {
          cpuRequest: '200m',
          cpuLimit: '1000m',
          memoryRequest: '256Mi',
          memoryLimit: '512Mi',
        },
      }).spec!.template!.spec!.containers[0];

      expect(container.resources?.requests?.cpu).toBe('200m');
      expect(container.resources?.limits?.memory).toBe('512Mi');
    });

    it('inlines only platform-owned env vars', () => {
      const container = service.buildDeployment(baseSpec).spec!.template!.spec!.containers[0];

      expect(container.env).toEqual([
        { name: 'MCP_SERVER_ID', value: 'stripe-abc123' },
        { name: 'MCP_TRANSPORT', value: 'http' },
        { name: 'PORT', value: '3000' },
      ]);
    });

    it('includes health probes on /health:3000', () => {
      const container = service.buildDeployment(baseSpec).spec!.template!.spec!.containers[0];

      expect(container.livenessProbe?.httpGet?.path).toBe('/health');
      expect(container.livenessProbe?.httpGet?.port).toBe(3000);
      expect(container.readinessProbe?.httpGet?.path).toBe('/health');
    });

    describe('pod hardening (none of which the old generated pod spec had)', () => {
      it('runs non-root with a read-only root filesystem and no capabilities', () => {
        const podSpec = service.buildDeployment(baseSpec).spec!.template!.spec!;
        const container = podSpec.containers[0];

        expect(podSpec.securityContext?.runAsNonRoot).toBe(true);
        expect(podSpec.securityContext?.seccompProfile?.type).toBe('RuntimeDefault');
        expect(container.securityContext?.runAsNonRoot).toBe(true);
        expect(container.securityContext?.readOnlyRootFilesystem).toBe(true);
        expect(container.securityContext?.allowPrivilegeEscalation).toBe(false);
        expect(container.securityContext?.capabilities?.drop).toEqual(['ALL']);
      });

      it('mounts a writable /tmp so a read-only root filesystem is actually viable', () => {
        const podSpec = service.buildDeployment(baseSpec).spec!.template!.spec!;

        expect(podSpec.containers[0].volumeMounts).toContainEqual({
          name: 'tmp',
          mountPath: '/tmp',
        });
        expect(podSpec.volumes).toContainEqual({ name: 'tmp', emptyDir: {} });
      });

      it('uses a dedicated ServiceAccount and projects no API token into the pod', () => {
        const podSpec = service.buildDeployment(baseSpec).spec!.template!.spec!;

        expect(podSpec.serviceAccountName).toBe('mcp-server-runtime');
        expect(podSpec.automountServiceAccountToken).toBe(false);
      });

      it('sets imagePullSecrets when one is configured, and omits the field otherwise', () => {
        const withSecret = service.buildDeployment({
          ...baseSpec,
          imagePullSecretName: 'ghcr-pull',
        });
        expect(withSecret.spec!.template!.spec!.imagePullSecrets).toEqual([{ name: 'ghcr-pull' }]);

        const without = service.buildDeployment(baseSpec);
        expect(without.spec!.template!.spec!.imagePullSecrets).toBeUndefined();
      });
    });

    describe('secret handling', () => {
      const withEnv: HostedServerSpec = {
        ...baseSpec,
        envVars: { STRIPE_API_KEY: 'sk_live_supersecret', DEBUG: 'true' },
      };

      it('NEVER puts user env vars in the Deployment as literal values', () => {
        const container = service.buildDeployment(withEnv).spec!.template!.spec!.containers[0];

        const inlinedNames = (container.env || []).map((e) => e.name);
        expect(inlinedNames).not.toContain('STRIPE_API_KEY');
        expect(inlinedNames).not.toContain('DEBUG');

        // Belt and braces: the secret value must not appear anywhere in the
        // serialized Deployment. This is the regression guard for the bug
        // where these were inlined and then committed to a GitHub repo.
        expect(JSON.stringify(container)).not.toContain('sk_live_supersecret');
      });

      it('references the env Secret via envFrom instead', () => {
        const container = service.buildDeployment(withEnv).spec!.template!.spec!.containers[0];

        expect(container.envFrom).toEqual([
          { secretRef: { name: 'mcp-stripe-abc123-env', optional: false } },
        ]);
      });

      it('omits envFrom entirely when there are no user env vars', () => {
        const container = service.buildDeployment(baseSpec).spec!.template!.spec!.containers[0];

        expect(container.envFrom).toBeUndefined();
      });
    });

    it('sanitizes a server name that is not a valid Kubernetes label value', () => {
      const deployment = service.buildDeployment({
        ...baseSpec,
        serverName: '  My Server!! (v2) ',
      });

      const label = deployment.metadata!.labels!['server-name'];
      expect(label).toMatch(/^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/);
      expect(label.length).toBeLessThanOrEqual(63);
    });
  });

  describe('buildService', () => {
    it('emits a ClusterIP Service exposing 80 -> 3000', () => {
      const svc = service.buildService(baseSpec);

      expect(svc.kind).toBe('Service');
      expect(svc.metadata?.name).toBe('mcp-stripe-abc123');
      expect(svc.spec?.type).toBe('ClusterIP');
      expect(svc.spec?.selector).toEqual({ app: 'mcp-server', 'server-id': 'stripe-abc123' });
      expect(svc.spec?.ports?.[0]).toMatchObject({ port: 80, targetPort: 3000, protocol: 'TCP' });
    });
  });

  describe('buildSecret', () => {
    it('puts user env vars in stringData (not double-encoded data)', () => {
      const secret = service.buildSecret({
        ...baseSpec,
        envVars: { STRIPE_API_KEY: 'sk_live_supersecret' },
      });

      expect(secret?.kind).toBe('Secret');
      expect(secret?.type).toBe('Opaque');
      expect(secret?.metadata?.name).toBe('mcp-stripe-abc123-env');
      expect(secret?.metadata?.namespace).toBe('mcp-servers');
      expect(secret?.stringData).toEqual({ STRIPE_API_KEY: 'sk_live_supersecret' });
      expect(secret?.data).toBeUndefined();
    });

    it('returns undefined rather than an empty Secret', () => {
      expect(service.buildSecret(baseSpec)).toBeUndefined();
      expect(service.buildSecret({ ...baseSpec, envVars: {} })).toBeUndefined();
    });
  });

  /**
   * The shape that makes Kubernetes hosting work at all.
   *
   * The backend pod has no docker binary and no docker socket, so it cannot
   * build a per-server image. Instead every hosted server runs the ONE shared
   * multi-arch `mcp-runner` image twice - as an initContainer that fetches and
   * compiles the generated source, and as the main container that serves it -
   * over a single emptyDir at /app.
   */
  describe('shared-runner deployment shape', () => {
    const withSource: HostedServerSpec = { ...baseSpec, envVars: { ...sourceEnv } };

    it('emits an initContainer running mcp-runner-init', () => {
      const podSpec = service.buildDeployment(withSource).spec!.template!.spec!;

      expect(podSpec.initContainers).toHaveLength(1);
      const init = podSpec.initContainers![0];
      expect(init.name).toBe(MCP_INIT_CONTAINER_NAME);
      expect(init.command).toEqual(['mcp-runner-init']);
    });

    it('runs the same runner image for both containers', () => {
      const podSpec = service.buildDeployment(withSource).spec!.template!.spec!;

      expect(podSpec.initContainers![0].image).toBe(DEFAULT_MCP_RUNNER_IMAGE);
      expect(podSpec.containers[0].image).toBe(DEFAULT_MCP_RUNNER_IMAGE);
      expect(podSpec.containers[0].command).toEqual(['mcp-runner-serve']);
    });

    it('references NO per-server image anywhere in the Deployment', () => {
      const deployment = service.buildDeployment(withSource);
      const serialized = JSON.stringify(deployment);

      // The old shape put `.../mcp-servers/<serverId>:<tag>` here. Nothing may
      // name this server as an image any more: no such image is ever built.
      const images = [
        ...deployment.spec!.template!.spec!.containers.map((c) => c.image),
        ...(deployment.spec!.template!.spec!.initContainers || []).map((c) => c.image),
      ];
      expect(new Set(images)).toEqual(new Set([DEFAULT_MCP_RUNNER_IMAGE]));
      expect(serialized).not.toContain('mcp-servers/stripe-abc123');
      expect(serialized).not.toContain('ghcr.io');
    });

    it('honours MCP_RUNNER_IMAGE so the tag can be pinned without a code change', async () => {
      const pinned = 'harbor.example/mcp-everything/mcp-runner:a109d73';
      const configured = await buildService({ MCP_RUNNER_IMAGE: pinned });
      const podSpec = configured.buildDeployment(withSource).spec!.template!.spec!;

      expect(podSpec.initContainers![0].image).toBe(pinned);
      expect(podSpec.containers[0].image).toBe(pinned);
    });

    it('shares one emptyDir at /app between the init and main containers', () => {
      const podSpec = service.buildDeployment(withSource).spec!.template!.spec!;

      expect(podSpec.volumes).toContainEqual({ name: 'app', emptyDir: {} });
      expect(podSpec.initContainers![0].volumeMounts).toContainEqual({
        name: 'app',
        mountPath: '/app',
      });
      expect(podSpec.containers[0].volumeMounts).toContainEqual({
        name: 'app',
        mountPath: '/app',
      });
    });

    it('gives the initContainer a writable /tmp, since its root filesystem is read-only', () => {
      const init = service.buildDeployment(withSource).spec!.template!.spec!.initContainers![0];

      expect(init.securityContext?.readOnlyRootFilesystem).toBe(true);
      expect(init.volumeMounts).toContainEqual({ name: 'tmp', mountPath: '/tmp' });
    });

    /**
     * Kubernetes does not apply an image's directory ownership to a mounted
     * emptyDir. Without fsGroup matching the runner's uid the initContainer
     * dies on its very first write, every time.
     */
    it('sets fsGroup 1000 to match the runner image user', () => {
      const podSpec = service.buildDeployment(withSource).spec!.template!.spec!;

      expect(podSpec.securityContext?.fsGroup).toBe(1000);
      expect(podSpec.securityContext?.runAsUser).toBe(1000);
      expect(podSpec.securityContext?.runAsGroup).toBe(1000);
      expect(podSpec.initContainers![0].securityContext?.runAsUser).toBe(1000);
      expect(podSpec.containers[0].securityContext?.runAsUser).toBe(1000);
    });

    it('projects MCP_SOURCE_URL/MCP_SOURCE_TOKEN onto the INIT container from the Secret', () => {
      const podSpec = service.buildDeployment(withSource).spec!.template!.spec!;
      const init = podSpec.initContainers![0];

      expect(init.env).toEqual([
        { name: 'MCP_APP_DIR', value: '/app' },
        {
          name: 'MCP_SOURCE_URL',
          valueFrom: {
            secretKeyRef: {
              name: 'mcp-stripe-abc123-env',
              key: 'MCP_SOURCE_URL',
              optional: false,
            },
          },
        },
        {
          name: 'MCP_SOURCE_TOKEN',
          valueFrom: {
            secretKeyRef: {
              name: 'mcp-stripe-abc123-env',
              key: 'MCP_SOURCE_TOKEN',
              optional: false,
            },
          },
        },
      ]);
    });

    it('never inlines the source token as a literal value', () => {
      const deployment = service.buildDeployment(withSource);

      expect(JSON.stringify(deployment)).not.toContain('mcpsrc_supersecrettokenvalue');
    });

    it('does not hand the build step the user\'s own credentials', () => {
      const podSpec = service.buildDeployment({
        ...baseSpec,
        envVars: { ...sourceEnv, STRIPE_API_KEY: 'sk_live_supersecret' },
      }).spec!.template!.spec!;

      // envFrom would project the WHOLE Secret; the init container gets only
      // the two keys it actually needs.
      expect(podSpec.initContainers![0].envFrom).toBeUndefined();
      expect(JSON.stringify(podSpec.initContainers![0])).not.toContain('STRIPE_API_KEY');
    });

    it('omits the source env when the spec carries none, rather than emitting a dangling ref', () => {
      const init = service.buildDeployment(baseSpec).spec!.template!.spec!.initContainers![0];

      expect(init.env).toEqual([{ name: 'MCP_APP_DIR', value: '/app' }]);
    });

    /**
     * `tsc` is the dominant cost of cold start and the most memory-hungry
     * thing in the pod. Sharing the serving container's 256Mi cap OOM-kills
     * the build.
     */
    it('gives the initContainer its own, larger resource budget', () => {
      const podSpec = service.buildDeployment(withSource).spec!.template!.spec!;
      const init = podSpec.initContainers![0];

      expect(init.resources?.limits?.memory).toBe('768Mi');
      expect(init.resources?.limits?.cpu).toBe('1000m');
      expect(podSpec.containers[0].resources?.limits?.memory).toBe('256Mi');
    });

    it('allows the init resources to be overridden per server', () => {
      const init = service.buildDeployment({
        ...withSource,
        initResources: { memoryLimit: '1Gi' },
      }).spec!.template!.spec!.initContainers![0];

      expect(init.resources?.limits?.memory).toBe('1Gi');
      // Unspecified fields still come from the defaults.
      expect(init.resources?.limits?.cpu).toBe('1000m');
    });
  });

  describe('naming helpers', () => {
    it('derives stable object names from a serverId', () => {
      expect(objectNameFor('stripe-abc123')).toBe('mcp-stripe-abc123');
      expect(secretNameFor('stripe-abc123')).toBe('mcp-stripe-abc123-env');
    });
  });
});
