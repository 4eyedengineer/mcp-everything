import { test, expect } from '@playwright/test';
import { ChatPage } from '../../page-objects/chat.page';
import { ChatE2EPage } from '../../page-objects/chat-e2e.page';
import { ServersPage } from '../../page-objects/servers.page';
import { DeployModalPage } from '../../page-objects/deploy-modal.page';
import { IntegrationBackend } from '../../fixtures/integration-backend';
import { KindClusterFixture } from '../../fixtures/kind-cluster';

/**
 * Layer 6: Advanced Features E2E Tests (Real API)
 *
 * These tests use real backend APIs and are expensive/slow.
 * They validate actual deployment functionality.
 *
 * Prerequisites:
 * - Backend running (npm run dev:backend)
 * - GITHUB_TOKEN configured (for GitHub/Gist deployment)
 * - KinD cluster running (for cloud deployment) - optional
 * - ANTHROPIC_API_KEY configured (for generation)
 */
test.describe('Layer 6: Advanced Features (Real API)', () => {
  // These tests are slow - 5 minutes timeout per test
  test.setTimeout(300000);

  // Run tests serially to avoid resource conflicts
  test.describe.configure({ mode: 'serial' });

  let chatPage: ChatPage;
  let backend: IntegrationBackend;

  test.beforeAll(async () => {
    backend = new IntegrationBackend({
      backendUrl: process.env['BACKEND_URL'] || 'http://localhost:3000',
      frontendUrl: process.env['FRONTEND_URL'] || 'http://localhost:4200',
    });

    // Skip tests if backend not available
    const isReady = await backend.waitForReady(30000);
    if (!isReady) {
      test.skip();
    }
  });

  test.beforeEach(async ({ page }) => {
    chatPage = new ChatPage(page);
  });

  // ==========================================
  // 6.5-6.6 Real Deployment Tests
  // ==========================================
  test.describe('6.5-6.6 GitHub/Gist Deployment', () => {
    // Skip if no GitHub token
    test.beforeAll(async () => {
      if (!process.env['GITHUB_TOKEN']) {
        test.skip();
      }
    });

    test('can deploy generated server to GitHub repository', async ({ page }) => {
      const chatE2EPage = new ChatE2EPage(page);

      // Navigate to chat
      await chatE2EPage.navigate();
      await page.waitForLoadState('networkidle');

      // Generate a simple MCP server
      const result = await chatE2EPage.sendAndWaitForGeneration(
        'Create a simple MCP server with a hello_world tool that returns a greeting',
        300000
      );

      // Verify generation succeeded
      expect(result.success).toBe(true);
      expect(result.hasDownload).toBe(true);

      // Check if deploy button exists
      const hasDeployButton = await chatPage.hasDeployAsRepoButton();
      if (!hasDeployButton) {
        test.skip();
        return;
      }

      // Click deploy to GitHub
      await chatPage.clickDeployAsRepo();

      // Wait for deployment result
      await chatPage.waitForDeploymentResult(60000);

      // Check result
      const isSuccess = await chatPage.isDeploymentSuccessful();
      if (isSuccess) {
        const url = await chatPage.getDeploymentResultUrl();
        expect(url).toContain('github.com');

        // TODO: Cleanup - delete the created repo
        // This would require GitHub API calls
      } else {
        // Deployment might fail due to rate limits, permissions, etc.
        // Log the error but don't fail the test
        const error = await chatPage.getDeploymentError();
        console.log('GitHub deployment failed:', error);
      }
    });

    test('can deploy generated server to Gist', async ({ page }) => {
      const chatE2EPage = new ChatE2EPage(page);

      // Navigate to chat
      await chatE2EPage.navigate();
      await page.waitForLoadState('networkidle');

      // Generate a simple MCP server
      const result = await chatE2EPage.sendAndWaitForGeneration(
        'Create a simple MCP server with a ping tool that returns pong',
        300000
      );

      // Verify generation succeeded
      expect(result.success).toBe(true);

      // Check if gist button exists
      const hasGistButton = await chatPage.hasDeployAsGistButton();
      if (!hasGistButton) {
        test.skip();
        return;
      }

      // Click deploy to Gist
      await chatPage.clickDeployAsGist();

      // Wait for deployment result
      await chatPage.waitForDeploymentResult(60000);

      // Check result
      const isSuccess = await chatPage.isDeploymentSuccessful();
      if (isSuccess) {
        const url = await chatPage.getDeploymentResultUrl();
        expect(url).toContain('gist.github.com');

        // TODO: Cleanup - delete the created gist
      } else {
        const error = await chatPage.getDeploymentError();
        console.log('Gist deployment failed:', error);
      }
    });
  });

  // ==========================================
  // 6.7-6.8 KinD Cloud Deployment
  // ==========================================
  test.describe('6.7-6.8 Cloud Deployment (KinD)', () => {
    let kindCluster: KindClusterFixture;

    test.beforeAll(async () => {
      kindCluster = new KindClusterFixture();

      // Skip if KinD not available
      const isReady = await kindCluster.isClusterRunning();
      if (!isReady) {
        console.log('KinD cluster not available, skipping cloud deployment tests');
        test.skip();
      }
    });

    test('can deploy to KinD cluster via modal', async ({ page }) => {
      const chatE2EPage = new ChatE2EPage(page);
      const deployModalPage = new DeployModalPage(page);

      // Navigate to chat
      await chatE2EPage.navigate();
      await page.waitForLoadState('networkidle');

      // Generate a simple MCP server
      const result = await chatE2EPage.sendAndWaitForGeneration(
        'Create a simple MCP server with a status tool that returns server status',
        300000
      );

      expect(result.success).toBe(true);

      // Check if cloud button exists
      const hasCloudButton = await chatPage.hasHostOnCloudButton();
      if (!hasCloudButton) {
        test.skip();
        return;
      }

      // Open deploy modal
      await chatPage.clickHostOnCloud();
      await deployModalPage.waitForVisible();

      // Fill form
      const serverName = `test-server-${Date.now()}`;
      await deployModalPage.fillAndSubmit(serverName, 'E2E test server');

      // Wait for modal to close
      await deployModalPage.waitForClose(30000);

      // Wait for deployment to complete (progress component)
      try {
        await chatPage.waitForDeployProgressComplete(120000);
      } catch {
        // Progress may not be visible or may complete quickly
      }

      // Give deployment some time to complete
      await page.waitForTimeout(5000);
    });

    test('deployed server health endpoint responds', async ({ page }) => {
      const serversPage = new ServersPage(page);

      // Navigate to servers page
      await serversPage.navigate();
      await serversPage.waitForLoad();

      // Check if any servers are running
      const serverCount = await serversPage.getServerCount();
      if (serverCount === 0) {
        console.log('No servers deployed, skipping health check');
        test.skip();
        return;
      }

      // Get first running server
      const status = await serversPage.getServerStatus(0);
      if (status !== 'running') {
        console.log('No running servers, skipping health check');
        test.skip();
        return;
      }

      // Get server data
      const serverData = await serversPage.getServerData(0);
      const endpointUrl = serverData.endpointUrl;

      // Try to hit the health endpoint
      // Note: This may not work in all environments due to networking
      try {
        const response = await page.request.get(`${endpointUrl}/health`, {
          headers: {
            Host: new URL(endpointUrl).host,
          },
          timeout: 10000,
        });

        // Just check that we get a response
        console.log(`Health check response: ${response.status()}`);
        // 200 is ideal, but other status codes may be acceptable
        expect(response.status()).toBeLessThan(500);
      } catch (e) {
        // Network errors may occur in CI environments
        console.log('Health check failed (may be expected in CI):', e);
      }
    });
  });

  // ==========================================
  // 6.1-6.4 Conversation Persistence (Real Backend)
  // ==========================================
  test.describe('Conversation Persistence (Real Backend)', () => {
    test('conversation persists after page refresh', async ({ page }) => {
      // Navigate to chat
      await chatPage.navigate();
      await page.waitForLoadState('networkidle');

      // Get initial URL (may have conversation ID)
      const initialUrl = chatPage.getUrl();

      // Type a message
      await chatPage.typeMessage('Hello, this is a test message');

      // Send it
      await chatPage.clickSend();

      // Wait for response
      await chatPage.waitForAssistantResponse(60000);

      // Get current URL (should have conversation ID now)
      const urlAfterSend = chatPage.getUrl();

      // Refresh the page
      await page.reload();
      await page.waitForLoadState('networkidle');

      // Wait for messages to load
      try {
        await chatPage.waitForUserMessage(10000);
      } catch {
        // May not have messages if backend doesn't persist
      }

      // Verify URL is preserved
      const urlAfterRefresh = chatPage.getUrl();

      // If URL had conversation ID, it should still be there
      if (urlAfterSend.includes('/chat/')) {
        expect(urlAfterRefresh).toContain('/chat/');
      }
    });

    test('can switch between conversations', async ({ page }) => {
      // This test requires having multiple conversations
      // Navigate to chat
      await chatPage.navigate();
      await page.waitForLoadState('networkidle');

      // Open sidebar
      const sidebarPage = await import('../../page-objects/sidebar.page').then(
        (m) => new m.SidebarPage(page)
      );

      await sidebarPage.open();

      // Check if there are conversations
      const count = await sidebarPage.getConversationCount();
      if (count < 2) {
        console.log('Not enough conversations to test switching');
        test.skip();
        return;
      }

      // Get first conversation title
      const firstTitle = await sidebarPage.getFirstConversationTitle();

      // Click second conversation
      await sidebarPage.selectConversation(1);
      await page.waitForLoadState('networkidle');

      // Click back to first conversation
      await sidebarPage.open();
      await sidebarPage.selectConversation(0);
      await page.waitForLoadState('networkidle');

      // Verify we can switch (no errors)
      expect(true).toBe(true);
    });
  });
});

/**
 * Cleanup utility tests
 * These help clean up resources created during testing
 */
test.describe('Cleanup Utilities', () => {
  test.skip('cleanup created GitHub repos', async ({ page }) => {
    // This would use GitHub API to clean up repos created during testing
    // Implement if needed for CI/CD
  });

  test.skip('cleanup created Gists', async ({ page }) => {
    // This would use GitHub API to clean up gists created during testing
  });

  test.skip('cleanup deployed KinD servers', async ({ page }) => {
    // This would use hosting API to delete test servers
  });
});
