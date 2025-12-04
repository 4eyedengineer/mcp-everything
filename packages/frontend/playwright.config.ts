import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E Test Configuration for MCP Everything Frontend
 *
 * Tests the Angular 20 application against a running backend.
 * Supports multiple browsers and includes retry logic for SSE tests.
 */
export default defineConfig({
  testDir: './e2e/tests',

  /* Run tests in files in parallel */
  fullyParallel: true,

  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,

  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,

  /* Opt out of parallel tests on CI. */
  workers: process.env.CI ? 1 : undefined,

  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: [
    ['html', { outputFolder: 'e2e/playwright-report' }],
    ['json', { outputFile: 'e2e/test-results.json' }],
    ['list']
  ],

  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    baseURL: process.env.FRONTEND_URL || 'http://localhost:4200',

    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'on-first-retry',

    /* Take screenshot only on failure */
    screenshot: 'only-on-failure',

    /* Video on first retry */
    video: 'retain-on-failure',

    /* Maximum time each action such as `click()` can take */
    actionTimeout: 10000,

    /* Custom viewport for desktop tests */
    viewport: { width: 1280, height: 720 },
  },

  /* Global timeout for each test */
  timeout: 60000,

  /* Timeout for expect() assertions */
  expect: {
    timeout: 10000,
  },

  /* Configure projects for major browsers */
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },

    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },

    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },

    /* Test against mobile viewports. */
    {
      name: 'Mobile Chrome',
      use: { ...devices['Pixel 5'] },
    },
    {
      name: 'Mobile Safari',
      use: { ...devices['iPhone 12'] },
    },

    /**
     * Core Features Tests (Layer 5)
     *
     * Tests chat, AI responses, and MCP server generation.
     * Uses real Claude API calls - costs money!
     *
     * Run with: npm run e2e:core-features
     */
    {
      name: 'core-features',
      testMatch: /core-features\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
      timeout: 300000, // 5 minutes per test for AI generation
      retries: 0, // No retries - costs money
    },

    /**
     * User Journeys Tests (Layer 7)
     *
     * End-to-end user journeys testing complete workflows:
     * - GitHub URL → Hosted Server
     * - Natural Language → GitHub Repo
     * - Error Recovery
     * - Multi-Conversation Flow
     *
     * Uses real Claude API for journeys 1-2 (costs money!)
     * Uses mocked backend for journeys 3-4 (fast, free)
     *
     * Run with: npm run e2e:user-journeys
     */
    {
      name: 'user-journeys',
      testMatch: /user-journeys\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
      timeout: 600000, // 10 minutes per test for full journey
      retries: 0, // No retries - costs money
    },

    /* Test against branded browsers. */
    // {
    //   name: 'Microsoft Edge',
    //   use: { ...devices['Desktop Edge'], channel: 'msedge' },
    // },
    // {
    //   name: 'Google Chrome',
    //   use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    // },
  ],

  /* Run your local dev server before starting the tests */
  webServer: [
    {
      command: 'npm run start',
      port: 4200,
      timeout: 120000,
      reuseExistingServer: !process.env.CI,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    // Optionally start backend for integration tests
    // Uncomment if you want Playwright to manage the backend
    // {
    //   command: 'cd ../backend && npm run start:dev',
    //   port: 3000,
    //   timeout: 120000,
    //   reuseExistingServer: !process.env.CI,
    //   cwd: '../backend',
    // },
  ],
});
