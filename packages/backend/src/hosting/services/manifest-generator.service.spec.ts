import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  HostedServerSpec,
  ManifestGeneratorService,
  objectNameFor,
  resolveImageRef,
  secretNameFor,
} from './manifest-generator.service';

describe('ManifestGeneratorService', () => {
  let service: ManifestGeneratorService;

  const baseSpec: HostedServerSpec = {
    serverId: 'stripe-abc123',
    serverName: 'stripe-mcp',
    dockerImage: 'ghcr.io/4eyedengineer/mcp-servers/stripe-abc123',
    imageTag: 'latest',
    namespace: 'mcp-servers',
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ManifestGeneratorService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: unknown) => {
              if (key === 'LOCAL_DEV') return undefined;
              return defaultValue;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<ManifestGeneratorService>(ManifestGeneratorService);
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

  describe('resolveImageRef', () => {
    /**
     * ContainerRegistryService.buildAndPush returns an already-tagged ref, and
     * the old YAML generator appended `:${imageTag}` to it unconditionally,
     * producing `...stripe-abc123:latest:latest` - an invalid reference that
     * would have put every pod into ImagePullBackOff.
     */
    it('does not re-tag an already-tagged reference', () => {
      expect(
        resolveImageRef('ghcr.io/owner/repo/stripe-abc123:latest', 'latest'),
      ).toBe('ghcr.io/owner/repo/stripe-abc123:latest');
    });

    it('appends the tag when the reference has none', () => {
      expect(resolveImageRef('ghcr.io/owner/repo/stripe-abc123', 'v2')).toBe(
        'ghcr.io/owner/repo/stripe-abc123:v2',
      );
    });

    it('defaults to :latest when no tag is supplied', () => {
      expect(resolveImageRef('ghcr.io/owner/repo/srv')).toBe('ghcr.io/owner/repo/srv:latest');
    });

    it('does not mistake a registry host port for a tag', () => {
      expect(resolveImageRef('localhost:5000/srv', 'latest')).toBe('localhost:5000/srv:latest');
      expect(resolveImageRef('localhost:5000/srv:dev', 'latest')).toBe('localhost:5000/srv:dev');
    });

    it('leaves a digest-pinned reference alone', () => {
      const digest = 'ghcr.io/owner/repo/srv@sha256:' + 'a'.repeat(64);
      expect(resolveImageRef(digest, 'latest')).toBe(digest);
    });

    it('is what buildDeployment uses for the container image', () => {
      const container = service.buildDeployment({
        ...baseSpec,
        dockerImage: 'ghcr.io/owner/repo/stripe-abc123:latest',
      }).spec!.template!.spec!.containers[0];

      expect(container.image).toBe('ghcr.io/owner/repo/stripe-abc123:latest');
    });
  });

  describe('naming helpers', () => {
    it('derives stable object names from a serverId', () => {
      expect(objectNameFor('stripe-abc123')).toBe('mcp-stripe-abc123');
      expect(secretNameFor('stripe-abc123')).toBe('mcp-stripe-abc123-env');
    });
  });
});
