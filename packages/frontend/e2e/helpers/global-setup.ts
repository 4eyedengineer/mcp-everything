import { FullConfig } from '@playwright/test';

/**
 * Global setup function for E2E tests
 * Runs once before all E2E tests start
 */
async function globalSetup(config: FullConfig): Promise<void> {
  console.log('\n=== E2E Test Suite Global Setup ===');
  console.log(`Base URL: ${config.projects[0]?.use?.baseURL || 'not set'}`);
  console.log(`Workers: ${config.workers}`);
  console.log(`Timeout: ${config.globalTimeout}ms`);

  // Verify environment variables
  const requiredEnvVars = ['FRONTEND_URL', 'BACKEND_URL'];
  const missingVars = requiredEnvVars.filter((v) => !process.env[v]);

  if (missingVars.length > 0) {
    console.log(
      `Warning: Missing environment variables: ${missingVars.join(', ')}`
    );
    console.log('Using default localhost URLs');
  }

  // Set default environment variables if not set
  process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:4200';
  process.env.BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';

  console.log(`Frontend URL: ${process.env.FRONTEND_URL}`);
  console.log(`Backend URL: ${process.env.BACKEND_URL}`);
  console.log('=== Setup Complete ===\n');
}

export default globalSetup;
