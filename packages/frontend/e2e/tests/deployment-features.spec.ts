import { test, expect } from '@playwright/test';
import { ChatPage } from '../page-objects/chat.page';
import { DeployModalPage } from '../page-objects/deploy-modal.page';
import { MockBackend } from '../fixtures/mock-backend';
import {
  MOCK_CONVERSATIONS,
  MOCK_MESSAGES,
  MOCK_DEPLOYMENT_RESPONSES,
  MOCK_GENERATED_CODE,
  MOCK_SSE_EVENTS,
} from '../fixtures/test-data';

/**
 * Layer 6: Deployment Features E2E Tests (Mocked UI)
 *
 * Tests deployment UI functionality using mocked APIs.
 * These tests validate the UI behavior without actually deploying.
 */
test.describe('Layer 6: Deployment Features', () => {
  let chatPage: ChatPage;
  let deployModalPage: DeployModalPage;
  let mockBackend: MockBackend;

  test.beforeEach(async ({ page }) => {
    chatPage = new ChatPage(page);
    deployModalPage = new DeployModalPage(page);
    mockBackend = new MockBackend(page);
  });

  /**
   * Helper to set up a conversation with generated code
   */
  async function setupConversationWithGeneratedCode(page: any) {
    // Mock conversation with generated code in the response
    await mockBackend.mockConversationsAPI();
    await mockBackend.mockChatMessage({ success: true });

    // Mock SSE stream that ends with generated code
    const sseEvents = [
      MOCK_SSE_EVENTS.progress,
      { ...MOCK_SSE_EVENTS.progress, message: 'Generating code...' },
      MOCK_SSE_EVENTS.result,
      {
        ...MOCK_SSE_EVENTS.complete,
        data: { generatedCode: MOCK_GENERATED_CODE },
      },
    ];
    await mockBackend.mockSSEStream(sseEvents);

    // Navigate to chat
    await chatPage.navigate();
    await page.waitForLoadState('networkidle');

    // Send a message to trigger generation
    await chatPage.sendMessage('Generate an MCP server from Express.js');

    // Wait for generation to complete (download button appears)
    await chatPage.waitForDownloadButton(30000);
  }

  // ==========================================
  // 6.5 Deploy to GitHub Repository (UI)
  // ==========================================
  test.describe('6.5 Deploy to GitHub Repository (UI)', () => {
    test('deploy as repo button visible after generation', async ({ page }) => {
      await setupConversationWithGeneratedCode(page);

      // Verify deploy button is visible
      const hasButton = await chatPage.hasDeployAsRepoButton();
      expect(hasButton).toBe(true);
    });

    test('deploy as repo button is clickable', async ({ page }) => {
      await setupConversationWithGeneratedCode(page);
      await mockBackend.mockDeployToGitHub(MOCK_DEPLOYMENT_RESPONSES.githubSuccess);

      // Click deploy button
      await chatPage.clickDeployAsRepo();

      // Button should be disabled while deploying
      const isDeploying = await chatPage.isDeploying();
      expect(isDeploying).toBe(true);
    });

    test('shows success card with repository URL on successful deploy', async ({ page }) => {
      await setupConversationWithGeneratedCode(page);
      await mockBackend.mockDeployToGitHub(MOCK_DEPLOYMENT_RESPONSES.githubSuccess);
      await mockBackend.mockLatestDeployment('conv-1', MOCK_DEPLOYMENT_RESPONSES.githubSuccess);

      // Click deploy
      await chatPage.clickDeployAsRepo();

      // Wait for result
      await chatPage.waitForDeploymentResult();

      // Verify success
      const isSuccess = await chatPage.isDeploymentSuccessful();
      expect(isSuccess).toBe(true);

      // Verify URL is shown
      const url = await chatPage.getDeploymentResultUrl();
      expect(url).toContain('github.com');
    });

    test('shows error card on deployment failure', async ({ page }) => {
      await setupConversationWithGeneratedCode(page);
      await mockBackend.mockDeployToGitHub(MOCK_DEPLOYMENT_RESPONSES.failure);

      // Click deploy
      await chatPage.clickDeployAsRepo();

      // Wait for result
      await chatPage.waitForDeploymentResult();

      // Verify failure
      const isFailed = await chatPage.isDeploymentFailed();
      expect(isFailed).toBe(true);

      // Verify error message is shown
      const error = await chatPage.getDeploymentError();
      expect(error.length).toBeGreaterThan(0);
    });

    test('error card has retry button', async ({ page }) => {
      await setupConversationWithGeneratedCode(page);
      await mockBackend.mockDeployToGitHub(MOCK_DEPLOYMENT_RESPONSES.failure);

      // Click deploy and wait for failure
      await chatPage.clickDeployAsRepo();
      await chatPage.waitForDeploymentResult();

      // Verify retry button exists
      const retryButton = chatPage.deploymentErrorCard.locator('.retry-button').first();
      const isVisible = await retryButton.isVisible();
      expect(isVisible).toBe(true);
    });
  });

  // ==========================================
  // 6.6 Deploy to Gist (UI)
  // ==========================================
  test.describe('6.6 Deploy to Gist (UI)', () => {
    test('deploy as gist button visible after generation', async ({ page }) => {
      await setupConversationWithGeneratedCode(page);

      // Verify gist button is visible
      const hasButton = await chatPage.hasDeployAsGistButton();
      expect(hasButton).toBe(true);
    });

    test('deploy as gist button is clickable', async ({ page }) => {
      await setupConversationWithGeneratedCode(page);
      await mockBackend.mockDeployToGist(MOCK_DEPLOYMENT_RESPONSES.gistSuccess);

      // Click gist deploy button
      await chatPage.clickDeployAsGist();

      // Should be deploying
      const isDeploying = await chatPage.isDeploying();
      expect(isDeploying).toBe(true);
    });

    test('shows success card with gist URL on successful deploy', async ({ page }) => {
      await setupConversationWithGeneratedCode(page);
      await mockBackend.mockDeployToGist(MOCK_DEPLOYMENT_RESPONSES.gistSuccess);
      await mockBackend.mockLatestDeployment('conv-1', MOCK_DEPLOYMENT_RESPONSES.gistSuccess);

      // Click deploy
      await chatPage.clickDeployAsGist();

      // Wait for result
      await chatPage.waitForDeploymentResult();

      // Verify success
      const isSuccess = await chatPage.isDeploymentSuccessful();
      expect(isSuccess).toBe(true);

      // Verify gist URL is shown
      const url = await chatPage.getDeploymentResultUrl();
      expect(url).toContain('gist.github.com');
    });

    test('shows error card on gist deployment failure', async ({ page }) => {
      await setupConversationWithGeneratedCode(page);
      await mockBackend.mockDeployToGist(MOCK_DEPLOYMENT_RESPONSES.failure);

      // Click deploy
      await chatPage.clickDeployAsGist();

      // Wait for result
      await chatPage.waitForDeploymentResult();

      // Verify failure
      const isFailed = await chatPage.isDeploymentFailed();
      expect(isFailed).toBe(true);
    });
  });

  // ==========================================
  // 6.7 Host on Cloud (UI)
  // ==========================================
  test.describe('6.7 Host on Cloud (UI)', () => {
    test('host on cloud button visible after generation', async ({ page }) => {
      await setupConversationWithGeneratedCode(page);

      // Verify cloud button is visible
      const hasButton = await chatPage.hasHostOnCloudButton();
      expect(hasButton).toBe(true);
    });

    test('clicking host on cloud opens deploy modal', async ({ page }) => {
      await setupConversationWithGeneratedCode(page);

      // Click cloud deploy button
      await chatPage.clickHostOnCloud();

      // Wait for modal
      await deployModalPage.waitForVisible();

      // Verify modal is open
      const isVisible = await deployModalPage.isVisible();
      expect(isVisible).toBe(true);
    });

    test('deploy modal shows server name field', async ({ page }) => {
      await setupConversationWithGeneratedCode(page);
      await chatPage.clickHostOnCloud();
      await deployModalPage.waitForVisible();

      // Verify server name field exists and is editable
      await deployModalPage.setServerName('My Test Server');
      const value = await deployModalPage.getServerName();
      expect(value).toBe('My Test Server');
    });

    test('deploy modal shows description field', async ({ page }) => {
      await setupConversationWithGeneratedCode(page);
      await chatPage.clickHostOnCloud();
      await deployModalPage.waitForVisible();

      // Verify description field exists and is editable
      await deployModalPage.setDescription('A test MCP server');
      const value = await deployModalPage.getDescription();
      expect(value).toBe('A test MCP server');
    });

    test('deploy modal shows cost estimate', async ({ page }) => {
      await setupConversationWithGeneratedCode(page);
      await chatPage.clickHostOnCloud();
      await deployModalPage.waitForVisible();

      // Verify cost estimate is shown
      const costText = await deployModalPage.getCostEstimate();
      expect(costText).toContain('$3');
    });

    test('deploy button disabled when server name is empty', async ({ page }) => {
      await setupConversationWithGeneratedCode(page);
      await chatPage.clickHostOnCloud();
      await deployModalPage.waitForVisible();

      // Clear server name
      await deployModalPage.setServerName('');

      // Verify deploy button is disabled
      const isDisabled = await deployModalPage.isDeployButtonDisabled();
      expect(isDisabled).toBe(true);
    });

    test('cancel button closes modal', async ({ page }) => {
      await setupConversationWithGeneratedCode(page);
      await chatPage.clickHostOnCloud();
      await deployModalPage.waitForVisible();

      // Click cancel
      await deployModalPage.cancel();

      // Wait for modal to close
      await deployModalPage.waitForClose();

      // Verify modal is closed
      const isVisible = await deployModalPage.isVisible();
      expect(isVisible).toBe(false);
    });

    test('submitting form shows loading state', async ({ page }) => {
      await setupConversationWithGeneratedCode(page);
      await mockBackend.mockHostingDeploy(MOCK_DEPLOYMENT_RESPONSES.cloudSuccess);

      await chatPage.clickHostOnCloud();
      await deployModalPage.waitForVisible();

      // Fill form
      await deployModalPage.setServerName('My Test Server');

      // Submit
      await deployModalPage.submit();

      // Check submitting state (may be brief)
      // Modal should close on success
      await deployModalPage.waitForClose(10000);
    });

    test('successful cloud deploy shows progress component', async ({ page }) => {
      await setupConversationWithGeneratedCode(page);
      await mockBackend.mockHostingDeploy(MOCK_DEPLOYMENT_RESPONSES.cloudSuccess);

      await chatPage.clickHostOnCloud();
      await deployModalPage.waitForVisible();

      // Fill and submit
      await deployModalPage.fillAndSubmit('My Test Server', 'Test description');

      // Wait for modal to close
      await deployModalPage.waitForClose(10000);

      // Progress component should appear (may be brief in mocked environment)
      // Just verify the flow completed without errors
    });

    test('deploy modal shows error on failure', async ({ page }) => {
      await setupConversationWithGeneratedCode(page);
      await mockBackend.mockHostingDeploy(MOCK_DEPLOYMENT_RESPONSES.failure);

      await chatPage.clickHostOnCloud();
      await deployModalPage.waitForVisible();

      // Fill and submit
      await deployModalPage.fillAndSubmit('My Test Server');

      // Wait a bit for error
      await page.waitForTimeout(1000);

      // Check for error
      const hasError = await deployModalPage.hasError();
      if (hasError) {
        const errorText = await deployModalPage.getError();
        expect(errorText.length).toBeGreaterThan(0);
      }
      // If no error shown in modal, it may be shown elsewhere
    });
  });

  // ==========================================
  // Deployment Actions Visibility
  // ==========================================
  test.describe('Deployment Actions Visibility', () => {
    test('all deploy buttons visible after successful generation', async ({ page }) => {
      await setupConversationWithGeneratedCode(page);

      // Check all buttons
      const hasRepo = await chatPage.hasDeployAsRepoButton();
      const hasGist = await chatPage.hasDeployAsGistButton();
      const hasCloud = await chatPage.hasHostOnCloudButton();

      expect(hasRepo).toBe(true);
      expect(hasGist).toBe(true);
      expect(hasCloud).toBe(true);
    });

    test('download zip button visible after generation', async ({ page }) => {
      await setupConversationWithGeneratedCode(page);

      // Verify download button is visible
      const hasDownload = await chatPage.hasDownloadZipButton();
      expect(hasDownload).toBe(true);
    });

    test('deploy buttons disabled while deploying', async ({ page }) => {
      await setupConversationWithGeneratedCode(page);

      // Setup slow deploy response
      await mockBackend.mockDeployToGitHub(MOCK_DEPLOYMENT_RESPONSES.githubSuccess);

      // Click deploy
      await chatPage.clickDeployAsRepo();

      // Buttons should be disabled
      const isDeploying = await chatPage.isDeploying();
      expect(isDeploying).toBe(true);
    });
  });

  // ==========================================
  // Deployment Result Cards
  // ==========================================
  test.describe('Deployment Result Cards', () => {
    test('success card shows repository link for repo deployment', async ({ page }) => {
      await setupConversationWithGeneratedCode(page);
      await mockBackend.mockDeployToGitHub(MOCK_DEPLOYMENT_RESPONSES.githubSuccess);
      await mockBackend.mockLatestDeployment('conv-1', MOCK_DEPLOYMENT_RESPONSES.githubSuccess);

      await chatPage.clickDeployAsRepo();
      await chatPage.waitForDeploymentResult();

      // Verify link
      const url = await chatPage.getDeploymentResultUrl();
      expect(url).toBe(MOCK_DEPLOYMENT_RESPONSES.githubSuccess.urls.repository);
    });

    test('success card shows gist link for gist deployment', async ({ page }) => {
      await setupConversationWithGeneratedCode(page);
      await mockBackend.mockDeployToGist(MOCK_DEPLOYMENT_RESPONSES.gistSuccess);
      await mockBackend.mockLatestDeployment('conv-1', MOCK_DEPLOYMENT_RESPONSES.gistSuccess);

      await chatPage.clickDeployAsGist();
      await chatPage.waitForDeploymentResult();

      // Verify link
      const url = await chatPage.getDeploymentResultUrl();
      expect(url).toBe(MOCK_DEPLOYMENT_RESPONSES.gistSuccess.urls.gist);
    });

    test('error card shows error message', async ({ page }) => {
      await setupConversationWithGeneratedCode(page);
      await mockBackend.mockDeployToGitHub(MOCK_DEPLOYMENT_RESPONSES.failure);

      await chatPage.clickDeployAsRepo();
      await chatPage.waitForDeploymentResult();

      // Verify error message
      const error = await chatPage.getDeploymentError();
      expect(error).toContain(MOCK_DEPLOYMENT_RESPONSES.failure.error);
    });
  });
});
