import { Test, TestingModule } from '@nestjs/testing';
import * as yaml from 'js-yaml';
import {
  ManifestGeneratorService,
  ManifestConfig,
} from './manifest-generator.service';

describe('ManifestGeneratorService', () => {
  let service: ManifestGeneratorService;

  const baseConfig: ManifestConfig = {
    serverId: 'stripe-abc123',
    serverName: 'stripe-mcp',
    dockerImage: 'ghcr.io/4eyedengineer/mcp-servers/stripe-abc123',
    imageTag: 'latest',
    domain: 'mcp.example.com',
    namespace: 'mcp-servers',
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ManifestGeneratorService],
    }).compile();

    service = module.get<ManifestGeneratorService>(ManifestGeneratorService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('generateManifests', () => {
    it('should return all three manifest types', () => {
      const manifests = service.generateManifests(baseConfig);

      expect(manifests.deployment).toBeDefined();
      expect(manifests.service).toBeDefined();
      expect(manifests.ingress).toBeDefined();
    });
  });

  describe('generateDeployment', () => {
    it('should generate valid Deployment YAML', () => {
      const manifests = service.generateManifests(baseConfig);
      const deployment = yaml.load(manifests.deployment) as any;

      expect(deployment.kind).toBe('Deployment');
      expect(deployment.apiVersion).toBe('apps/v1');
      expect(deployment.metadata.name).toBe('mcp-stripe-abc123');
      expect(deployment.metadata.namespace).toBe('mcp-servers');
    });

    it('should include correct labels', () => {
      const manifests = service.generateManifests(baseConfig);
      const deployment = yaml.load(manifests.deployment) as any;

      expect(deployment.metadata.labels.app).toBe('mcp-server');
      expect(deployment.metadata.labels['server-id']).toBe('stripe-abc123');
      expect(deployment.metadata.labels['server-name']).toBe('stripe-mcp');
    });

    it('should use default resource limits', () => {
      const manifests = service.generateManifests(baseConfig);
      const deployment = yaml.load(manifests.deployment) as any;
      const container = deployment.spec.template.spec.containers[0];

      expect(container.resources.requests.cpu).toBe('100m');
      expect(container.resources.requests.memory).toBe('128Mi');
      expect(container.resources.limits.cpu).toBe('500m');
      expect(container.resources.limits.memory).toBe('256Mi');
    });

    it('should allow custom resource limits', () => {
      const config: ManifestConfig = {
        ...baseConfig,
        resources: {
          cpuRequest: '200m',
          cpuLimit: '1000m',
          memoryRequest: '256Mi',
          memoryLimit: '512Mi',
        },
      };

      const manifests = service.generateManifests(config);
      const deployment = yaml.load(manifests.deployment) as any;
      const container = deployment.spec.template.spec.containers[0];

      expect(container.resources.requests.cpu).toBe('200m');
      expect(container.resources.requests.memory).toBe('256Mi');
      expect(container.resources.limits.cpu).toBe('1000m');
      expect(container.resources.limits.memory).toBe('512Mi');
    });

    it('should include environment variables', () => {
      const config: ManifestConfig = {
        ...baseConfig,
        envVars: {
          API_KEY: 'test-key',
          DEBUG: 'true',
        },
      };

      const manifests = service.generateManifests(config);
      const deployment = yaml.load(manifests.deployment) as any;
      const container = deployment.spec.template.spec.containers[0];

      const envVars = container.env;
      expect(envVars).toContainEqual({ name: 'MCP_SERVER_ID', value: 'stripe-abc123' });
      expect(envVars).toContainEqual({ name: 'PORT', value: '3000' });
      expect(envVars).toContainEqual({ name: 'API_KEY', value: 'test-key' });
      expect(envVars).toContainEqual({ name: 'DEBUG', value: 'true' });
    });

    it('should include health probes', () => {
      const manifests = service.generateManifests(baseConfig);
      const deployment = yaml.load(manifests.deployment) as any;
      const container = deployment.spec.template.spec.containers[0];

      expect(container.livenessProbe.httpGet.path).toBe('/health');
      expect(container.livenessProbe.httpGet.port).toBe(3000);
      expect(container.readinessProbe.httpGet.path).toBe('/health');
      expect(container.readinessProbe.httpGet.port).toBe(3000);
    });

    it('should set correct container image', () => {
      const manifests = service.generateManifests(baseConfig);
      const deployment = yaml.load(manifests.deployment) as any;
      const container = deployment.spec.template.spec.containers[0];

      expect(container.image).toBe(
        'ghcr.io/4eyedengineer/mcp-servers/stripe-abc123:latest',
      );
    });
  });

  describe('generateService', () => {
    it('should generate valid Service YAML', () => {
      const manifests = service.generateManifests(baseConfig);
      const svc = yaml.load(manifests.service) as any;

      expect(svc.kind).toBe('Service');
      expect(svc.apiVersion).toBe('v1');
      expect(svc.metadata.name).toBe('mcp-stripe-abc123');
      expect(svc.metadata.namespace).toBe('mcp-servers');
    });

    it('should include correct selector', () => {
      const manifests = service.generateManifests(baseConfig);
      const svc = yaml.load(manifests.service) as any;

      expect(svc.spec.selector.app).toBe('mcp-server');
      expect(svc.spec.selector['server-id']).toBe('stripe-abc123');
    });

    it('should expose port 80 targeting 3000', () => {
      const manifests = service.generateManifests(baseConfig);
      const svc = yaml.load(manifests.service) as any;

      expect(svc.spec.ports[0].port).toBe(80);
      expect(svc.spec.ports[0].targetPort).toBe(3000);
      expect(svc.spec.ports[0].protocol).toBe('TCP');
    });
  });

  describe('generateIngress', () => {
    it('should generate valid Ingress YAML', () => {
      const manifests = service.generateManifests(baseConfig);
      const ingress = yaml.load(manifests.ingress) as any;

      expect(ingress.kind).toBe('Ingress');
      expect(ingress.apiVersion).toBe('networking.k8s.io/v1');
      expect(ingress.metadata.name).toBe('mcp-stripe-abc123');
      expect(ingress.metadata.namespace).toBe('mcp-servers');
    });

    it('should configure TLS with correct host', () => {
      const manifests = service.generateManifests(baseConfig);
      const ingress = yaml.load(manifests.ingress) as any;

      expect(ingress.spec.tls[0].hosts[0]).toBe('stripe-abc123.mcp.example.com');
      expect(ingress.spec.tls[0].secretName).toBe('mcp-stripe-abc123-tls');
    });

    it('should include nginx and cert-manager annotations', () => {
      const manifests = service.generateManifests(baseConfig);
      const ingress = yaml.load(manifests.ingress) as any;

      expect(ingress.metadata.annotations['kubernetes.io/ingress.class']).toBe(
        'nginx',
      );
      expect(
        ingress.metadata.annotations['cert-manager.io/cluster-issuer'],
      ).toBe('letsencrypt-prod');
    });

    it('should configure routing to service', () => {
      const manifests = service.generateManifests(baseConfig);
      const ingress = yaml.load(manifests.ingress) as any;

      const rule = ingress.spec.rules[0];
      expect(rule.host).toBe('stripe-abc123.mcp.example.com');
      expect(rule.http.paths[0].path).toBe('/');
      expect(rule.http.paths[0].pathType).toBe('Prefix');
      expect(rule.http.paths[0].backend.service.name).toBe('mcp-stripe-abc123');
      expect(rule.http.paths[0].backend.service.port.number).toBe(80);
    });
  });

  describe('generateKustomization', () => {
    it('should generate valid Kustomization YAML', () => {
      const kustomization = yaml.load(
        service.generateKustomization('stripe-abc123'),
      ) as any;

      expect(kustomization.kind).toBe('Kustomization');
      expect(kustomization.apiVersion).toBe('kustomize.config.k8s.io/v1beta1');
    });

    it('should include all manifest files as resources', () => {
      const kustomization = yaml.load(
        service.generateKustomization('stripe-abc123'),
      ) as any;

      expect(kustomization.resources).toContain('deployment.yaml');
      expect(kustomization.resources).toContain('service.yaml');
      expect(kustomization.resources).toContain('ingress.yaml');
    });

    it('should include common labels', () => {
      const kustomization = yaml.load(
        service.generateKustomization('stripe-abc123'),
      ) as any;

      expect(kustomization.commonLabels['managed-by']).toBe('mcp-everything');
      expect(kustomization.commonLabels['server-id']).toBe('stripe-abc123');
    });
  });
});
