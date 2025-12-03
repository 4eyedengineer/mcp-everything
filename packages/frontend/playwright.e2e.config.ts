import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E Test Configuration for MCP Everything
 *
 * This configuration is designed for end-to-end tests that require:
 * - Real Claude API integration
 * - KinD deployment validation
 * - Full system integration testing
 *
 * Usage: npx playwright test --config=playwright.e2e.config.ts
 */
export default defineConfig({
  testDir: './e2e/tests/e2e',

  /* 5 minutes per test - E2E tests with AI can be slow */
  timeout: 300000,

  /* Sequential execution - avoid resource conflicts */
  fullyParallel: false,

  /* Fail the build on CI if you accidentally left test.only in the source code */
  forbidOnly: !!process.env.CI,

  /* One retry for flaky network issues */
  retries: 1,

  /* Single worker to avoid resource conflicts */
  workers: 1,

  /* Reporter configuration */
  reporter: [
    ['html', { outputFolder: 'e2e/playwright-report-e2e' }],
    ['json', { outputFile: 'e2e/test-results-e2e.json' }],
    ['list'],
  ],

  /* Global setup and teardown */
  globalSetup: './e2e/helpers/global-setup.ts',
  globalTeardown: './e2e/helpers/global-teardown.ts',

  /* Shared settings for all projects */
  use: {
    /* Base URL for frontend */
    baseURL: process.env.FRONTEND_URL || 'http://localhost:4200',

    /* Always capture traces for debugging */
    trace: 'on',

    /* Always capture screenshots */
    screenshot: 'on',

    /* Always record videos */
    video: 'on',

    /* 30 seconds per action - chat responses can be slow */
    actionTimeout: 30000,

    /* Desktop viewport */
    viewport: { width: 1280, height: 720 },
  },

  /* 60 seconds for assertions */
  expect: {
    timeout: 60000,
  },

  /* Chromium only for E2E - faster and more reliable */
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  /* Configure web servers for both frontend and backend */
  webServer: [
    {
      command: 'npm run start',
      port: 4200,
      timeout: 120000,
      reuseExistingServer: true,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'npm run start:dev',
      port: 3000,
      timeout: 120000,
      reuseExistingServer: true,
      cwd: '../backend',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
