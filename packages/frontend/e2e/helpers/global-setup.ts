import { FullConfig } from '@playwright/test';
import { KindClusterFixture } from '../fixtures/kind-cluster';
import { E2EBackendFixture } from '../fixtures/e2e-backend';

/**
 * Global setup function for E2E tests
 * Validates all infrastructure requirements before tests run
 */
async function globalSetup(config: FullConfig): Promise<void> {
  console.log('\n🚀 E2E Test Suite - Global Setup\n');
  console.log('='.repeat(50));

  const issues: string[] = [];
  const kindCluster = new KindClusterFixture();
  const backend = new E2EBackendFixture();

  // Check 1: KinD Cluster
  console.log('Checking KinD cluster...');
  if (!(await kindCluster.isClusterRunning())) {
    issues.push(
      'KinD cluster "mcp-local" is not running. Run: ./scripts/kind/setup.sh'
    );
  } else {
    console.log('  ✓ KinD cluster is running');
  }

  // Check 2: Docker Registry
  console.log('Checking local registry...');
  if (!(await kindCluster.isRegistryRunning())) {
    issues.push(
      'Local Docker registry is not running. Run: ./scripts/kind/setup.sh'
    );
  } else {
    console.log('  ✓ Local registry is running');
  }

  // Check 3: Ingress Controller
  console.log('Checking ingress controller...');
  if (!(await kindCluster.isIngressReady())) {
    issues.push('Nginx ingress controller is not ready');
  } else {
    console.log('  ✓ Ingress controller is ready');
  }

  // Check 4: Backend Health
  console.log('Checking backend API...');
  if (!(await backend.isReady())) {
    issues.push(
      'Backend API is not responding at http://localhost:3000. Run: npm run dev:backend'
    );
  } else {
    console.log('  ✓ Backend API is healthy');
  }

  // Check 5: Claude API Key
  console.log('Checking Claude API configuration...');
  if (!process.env.ANTHROPIC_API_KEY) {
    issues.push('ANTHROPIC_API_KEY environment variable is not set');
  } else {
    console.log('  ✓ Claude API key is configured');
  }

  // Check 6: Namespace
  console.log('Checking mcp-servers namespace...');
  if (!(await kindCluster.isNamespaceExists())) {
    issues.push('mcp-servers namespace does not exist');
  } else {
    console.log('  ✓ mcp-servers namespace exists');
  }

  console.log('='.repeat(50));

  // Set default environment variables
  process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:4200';
  process.env.BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';

  if (issues.length > 0) {
    console.log('\n❌ E2E Setup Failed!\n');
    console.log('Issues found:');
    issues.forEach((issue, i) => console.log(`  ${i + 1}. ${issue}`));
    console.log('\nPlease fix the above issues and try again.\n');
    throw new Error(`E2E setup failed: ${issues.length} issues found`);
  }

  console.log('\n✅ E2E Setup Complete - All checks passed!\n');
}

export default globalSetup;
