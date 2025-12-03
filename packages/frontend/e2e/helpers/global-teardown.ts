import { FullConfig } from '@playwright/test';

/**
 * Global teardown function for E2E tests
 * Runs once after all E2E tests complete
 */
async function globalTeardown(config: FullConfig): Promise<void> {
  console.log('\n=== E2E Test Suite Global Teardown ===');
  console.log('Cleaning up test artifacts...');

  // Add any cleanup logic here
  // Examples:
  // - Clean up test databases
  // - Remove temporary files
  // - Reset external service states

  console.log('Teardown complete');
  console.log('=== Teardown Complete ===\n');
}

export default globalTeardown;
