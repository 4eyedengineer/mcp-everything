import { FullConfig } from '@playwright/test';
import { KindClusterFixture } from '../fixtures/kind-cluster';

/**
 * Global teardown function for E2E tests
 * Cleans up test resources created during tests
 */
async function globalTeardown(config: FullConfig): Promise<void> {
  console.log('\n🧹 E2E Test Suite - Global Teardown\n');
  console.log('='.repeat(50));

  const kindCluster = new KindClusterFixture();

  try {
    // List all servers created during tests
    const servers = await kindCluster.listServers();
    const testServers = servers.filter(
      (s) => s.startsWith('test-') || s.startsWith('e2e-') || s.includes('-test-')
    );

    if (testServers.length === 0) {
      console.log('No test servers to clean up');
    } else {
      console.log(`Found ${testServers.length} test server(s) to clean up:`);

      for (const serverId of testServers) {
        console.log(`  Cleaning up: ${serverId}...`);
        try {
          await kindCluster.cleanupTestServer(serverId);
          console.log(`    ✓ Cleaned up ${serverId}`);
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          console.log(`    ⚠ Failed to clean up ${serverId}: ${errorMessage}`);
        }
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.log(`\n⚠ Teardown encountered errors: ${errorMessage}`);
    console.log('Some test resources may need manual cleanup');
  }

  console.log('='.repeat(50));
  console.log('\n✅ E2E Teardown Complete!\n');
}

export default globalTeardown;
