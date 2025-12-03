import { KindClusterFixture } from '../fixtures/kind-cluster';
import { E2EBackendFixture } from '../fixtures/e2e-backend';

export interface EnvironmentCheck {
  name: string;
  passed: boolean;
  message: string;
  fix?: string;
}

export interface EnvironmentStatus {
  ready: boolean;
  checks: EnvironmentCheck[];
}

/**
 * Check all E2E environment requirements and return status
 */
export async function checkE2EEnvironment(): Promise<EnvironmentStatus> {
  const kindCluster = new KindClusterFixture();
  const backend = new E2EBackendFixture();
  const checks: EnvironmentCheck[] = [];

  // Check 1: KinD Cluster
  const clusterRunning = await kindCluster.isClusterRunning();
  checks.push({
    name: 'KinD Cluster',
    passed: clusterRunning,
    message: clusterRunning
      ? 'KinD cluster is running'
      : 'KinD cluster "mcp-local" is not running',
    fix: clusterRunning ? undefined : './scripts/kind/setup.sh',
  });

  // Check 2: Docker Registry
  const registryRunning = await kindCluster.isRegistryRunning();
  checks.push({
    name: 'Docker Registry',
    passed: registryRunning,
    message: registryRunning
      ? 'Local registry is running'
      : 'Local Docker registry is not running',
    fix: registryRunning ? undefined : './scripts/kind/setup.sh',
  });

  // Check 3: Ingress Controller
  const ingressReady = await kindCluster.isIngressReady();
  checks.push({
    name: 'Ingress Controller',
    passed: ingressReady,
    message: ingressReady
      ? 'Ingress controller is ready'
      : 'Nginx ingress controller is not ready',
    fix: ingressReady ? undefined : './scripts/kind/setup.sh',
  });

  // Check 4: Backend Health
  const backendReady = await backend.isReady();
  checks.push({
    name: 'Backend API',
    passed: backendReady,
    message: backendReady
      ? 'Backend API is healthy'
      : 'Backend API is not responding at http://localhost:3000',
    fix: backendReady ? undefined : 'npm run dev:backend',
  });

  // Check 5: Claude API Key
  const apiKeySet = !!process.env.ANTHROPIC_API_KEY;
  checks.push({
    name: 'Claude API Key',
    passed: apiKeySet,
    message: apiKeySet
      ? 'Claude API key is configured'
      : 'ANTHROPIC_API_KEY environment variable is not set',
    fix: apiKeySet ? undefined : 'export ANTHROPIC_API_KEY=your-key',
  });

  // Check 6: Namespace
  const namespaceExists = await kindCluster.isNamespaceExists();
  checks.push({
    name: 'K8s Namespace',
    passed: namespaceExists,
    message: namespaceExists
      ? 'mcp-servers namespace exists'
      : 'mcp-servers namespace does not exist',
    fix: namespaceExists ? undefined : './scripts/kind/setup.sh',
  });

  const ready = checks.every((c) => c.passed);

  return { ready, checks };
}

/**
 * Require E2E environment to be ready, throw if not
 * Can be used by individual tests to skip gracefully
 */
export async function requireE2EEnvironment(): Promise<void> {
  const status = await checkE2EEnvironment();
  if (!status.ready) {
    const failedChecks = status.checks.filter((c) => !c.passed);
    const errorLines = failedChecks.map((c) => {
      let line = `- ${c.message}`;
      if (c.fix) {
        line += `\n    Fix: ${c.fix}`;
      }
      return line;
    });
    throw new Error(`E2E environment not ready:\n${errorLines.join('\n')}`);
  }
}
