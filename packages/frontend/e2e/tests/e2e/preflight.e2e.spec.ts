import { test, expect } from '@playwright/test';
import { KindClusterFixture } from '../../fixtures/kind-cluster';
import { E2EBackendFixture } from '../../fixtures/e2e-backend';
import { ChatE2EPage } from '../../page-objects/chat-e2e.page';

/**
 * E2E Pre-flight Checks
 *
 * These tests validate all infrastructure components before running the main E2E test suite.
 * They run first and fail fast if any dependencies are missing.
 *
 * Run independently: npm run e2e:preflight
 */
test.describe('E2E Pre-flight Checks', () => {
  test.describe.configure({
    mode: 'serial',
    timeout: 30000, // 30s per test is plenty for preflight
  });

  let kindCluster: KindClusterFixture;
  let backend: E2EBackendFixture;

  test.beforeAll(async () => {
    kindCluster = new KindClusterFixture();
    backend = new E2EBackendFixture();
  });

  test('KinD cluster is running', async () => {
    const isRunning = await kindCluster.isClusterRunning();
    expect(
      isRunning,
      'KinD cluster "mcp-local" should be running. Run: ./scripts/kind/setup.sh'
    ).toBe(true);
  });

  test('Local Docker registry is accessible', async () => {
    const isRunning = await kindCluster.isRegistryRunning();
    expect(
      isRunning,
      'Local registry should be running at localhost:5000'
    ).toBe(true);
  });

  test('Nginx ingress controller is ready', async () => {
    const isReady = await kindCluster.isIngressReady();
    expect(
      isReady,
      'Nginx ingress controller should be in Running state'
    ).toBe(true);
  });

  test('ArgoCD is healthy', async () => {
    const isHealthy = await kindCluster.isArgoCDHealthy();
    // ArgoCD is optional - warn but don't fail
    if (!isHealthy) {
      console.warn('⚠ ArgoCD is not healthy - GitOps sync may not work');
    }
  });

  test('Backend API is responding', async () => {
    const health = await backend.healthCheck();
    expect(health.status).toBe('ok');
  });

  test('Backend SSE endpoint is accessible', async ({ page }) => {
    // Quick check that SSE endpoint doesn't 404
    const response = await page.request.get(
      'http://localhost:3000/api/chat/stream/test-session'
    );
    expect(response.status()).not.toBe(404);
  });

  test('Frontend is accessible', async ({ page }) => {
    await page.goto('/');
    // Should redirect to /chat
    await expect(page).toHaveURL(/\/chat/);
  });

  test('Frontend chat page loads correctly', async ({ page }) => {
    const chatPage = new ChatE2EPage(page);
    await chatPage.navigate();

    // Verify key elements exist
    await expect(chatPage.messageInput).toBeVisible();
    await expect(chatPage.sendButton).toBeVisible();
  });

  test('Claude API key is configured', async () => {
    const isConfigured = await backend.validateClaudeApiKey();
    expect(
      isConfigured,
      'ANTHROPIC_API_KEY should be set and valid'
    ).toBe(true);
  });

  test('mcp-servers namespace exists', async () => {
    const exists = await kindCluster.isNamespaceExists();
    expect(
      exists,
      'mcp-servers namespace should exist in cluster'
    ).toBe(true);
  });

  test('Can send test message without error', async ({ page }) => {
    const chatPage = new ChatE2EPage(page);
    await chatPage.navigate();

    // Send a simple help message
    await chatPage.sendMessage('help');

    // Should get some response (not necessarily AI response, could be error about API)
    // Just verify the system doesn't crash
    await expect(chatPage.userMessages.first()).toBeVisible({ timeout: 5000 });
  });
});
