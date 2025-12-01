import { test, expect } from '@playwright/test';
import { ChatPage } from '../page-objects/chat.page';
import { MockBackend } from '../fixtures/mock-backend';
import { MOCK_SSE_EVENTS, TEST_MESSAGES, TIMEOUTS } from '../fixtures/test-data';

test.describe('SSE Streaming', () => {
  let chatPage: ChatPage;
  let mockBackend: MockBackend;

  test.beforeEach(async ({ page }) => {
    chatPage = new ChatPage(page);
    mockBackend = new MockBackend(page);

    await chatPage.navigate();
  });

  test.describe('Progress Messages', () => {
    test('should display progress message during processing', async () => {
      await mockBackend.mockChatMessage();
      await mockBackend.mockSSEStream([
        MOCK_SSE_EVENTS.progress,
        { ...MOCK_SSE_EVENTS.progress, message: 'Still processing...' },
      ]);

      await chatPage.sendMessage(TEST_MESSAGES.simple);

      // Progress message should appear
      await chatPage.waitForProgressMessage(TIMEOUTS.medium);
      await expect(chatPage.progressMessages.first()).toBeVisible();

      const progressText = await chatPage.getProgressMessage();
      expect(progressText).toBeTruthy();
    });

    test('should update progress message in-place', async ({ page }) => {
      await mockBackend.mockChatMessage();

      // Simulate multiple progress updates
      const progressUpdates = [
        { ...MOCK_SSE_EVENTS.progress, message: 'Step 1: Analyzing...' },
        { ...MOCK_SSE_EVENTS.progress, message: 'Step 2: Generating...' },
        { ...MOCK_SSE_EVENTS.progress, message: 'Step 3: Validating...' },
      ];

      await mockBackend.mockSSEStream(progressUpdates);

      await chatPage.sendMessage(TEST_MESSAGES.simple);
      await chatPage.waitForProgressMessage();

      // Should only have one progress message (updated in place)
      await page.waitForTimeout(1000); // Wait for all updates
      const progressCount = await chatPage.getProgressMessageCount();
      expect(progressCount).toBeLessThanOrEqual(1);
    });

    test('should show spinning icon for progress messages', async () => {
      await mockBackend.mockChatMessage();
      await mockBackend.mockSSEStream([MOCK_SSE_EVENTS.progress]);

      await chatPage.sendMessage(TEST_MESSAGES.simple);
      await chatPage.waitForProgressMessage();

      // Check for spinning icon
      const progressMessage = chatPage.progressMessages.first();
      const icon = progressMessage.locator('mat-icon');
      await expect(icon).toHaveText('autorenew');
    });
  });

  test.describe('Result Messages', () => {
    test('should display assistant result message', async () => {
      await mockBackend.mockChatMessage();
      await mockBackend.mockSSEStream([
        MOCK_SSE_EVENTS.progress,
        MOCK_SSE_EVENTS.result,
      ]);

      await chatPage.sendMessage(TEST_MESSAGES.simple);

      // Wait for assistant response
      await chatPage.waitForAssistantResponse(TIMEOUTS.long);
      await expect(chatPage.assistantMessages.first()).toBeVisible();

      const assistantMsg = await chatPage.getLastAssistantMessage();
      expect(assistantMsg).toBeTruthy();
    });

    test('should clear progress message when result arrives', async ({ page }) => {
      await mockBackend.mockChatMessage();
      await mockBackend.mockSSEStream([
        MOCK_SSE_EVENTS.progress,
        MOCK_SSE_EVENTS.result,
      ]);

      await chatPage.sendMessage(TEST_MESSAGES.simple);

      // Wait for progress
      await chatPage.waitForProgressMessage();

      // Wait for result
      await chatPage.waitForAssistantResponse();

      // Progress message should be gone
      const progressCount = await chatPage.getProgressMessageCount();
      expect(progressCount).toBe(0);
    });
  });

  test.describe('Complete Messages', () => {
    test('should display download button on completion', async () => {
      await mockBackend.mockCompleteSSEFlow(true);
      await mockBackend.mockChatMessage();

      await chatPage.sendMessage(TEST_MESSAGES.simple);

      // Wait for download button
      await chatPage.waitForDownloadButton(TIMEOUTS.long);
      await expect(chatPage.downloadButton).toBeVisible();

      const isVisible = await chatPage.isDownloadButtonVisible();
      expect(isVisible).toBe(true);
    });

    test('should download generated code as JSON', async ({ page }) => {
      await mockBackend.mockCompleteSSEFlow(true);
      await mockBackend.mockChatMessage();

      await chatPage.sendMessage(TEST_MESSAGES.simple);

      await chatPage.waitForDownloadButton();

      // Setup download handler
      const downloadPromise = page.waitForEvent('download');
      await chatPage.downloadButton.click();
      const download = await downloadPromise;

      // Verify download
      expect(download.suggestedFilename()).toBe('mcp-server.json');

      const path = await download.path();
      expect(path).toBeTruthy();
    });

    test('should complete without download button if no code', async () => {
      await mockBackend.mockChatMessage();
      await mockBackend.mockSSEStream([
        MOCK_SSE_EVENTS.progress,
        MOCK_SSE_EVENTS.result,
        { ...MOCK_SSE_EVENTS.complete, data: undefined },
      ]);

      await chatPage.sendMessage(TEST_MESSAGES.simple);

      await chatPage.waitForAssistantResponse();

      // No download button should appear
      const isVisible = await chatPage.isDownloadButtonVisible();
      expect(isVisible).toBe(false);
    });
  });

  test.describe('Error Messages', () => {
    test('should display error message from SSE', async () => {
      await mockBackend.mockChatMessage();
      await mockBackend.mockSSEError('Generation failed');

      await chatPage.sendMessage(TEST_MESSAGES.simple);

      // Wait for error message
      await expect(chatPage.errorMessages.first()).toBeVisible({ timeout: TIMEOUTS.medium });

      const errorMsg = await chatPage.getErrorMessage();
      expect(errorMsg).toContain('Generation failed');
    });

    test('should clear progress when error occurs', async () => {
      await mockBackend.mockChatMessage();
      await mockBackend.mockSSEError();

      await chatPage.sendMessage(TEST_MESSAGES.simple);

      // Wait for error
      await expect(chatPage.errorMessages.first()).toBeVisible();

      // Progress should be cleared
      const progressCount = await chatPage.getProgressMessageCount();
      expect(progressCount).toBe(0);
    });

    test('should clear loading state on error', async () => {
      await mockBackend.mockChatMessage();
      await mockBackend.mockSSEError();

      await chatPage.sendMessage(TEST_MESSAGES.simple);

      await expect(chatPage.errorMessages.first()).toBeVisible();

      // Loading should be complete
      const isLoading = await chatPage.isLoading();
      expect(isLoading).toBe(false);
    });
  });

  test.describe('SSE Connection Management', () => {
    test('should establish SSE connection on page load', async ({ page }) => {
      // Wait for SSE connection request
      const sseRequest = page.waitForRequest((req) =>
        req.url().includes('/api/chat/stream/')
      );

      await chatPage.navigate();

      const request = await sseRequest;
      expect(request.url()).toContain('/api/chat/stream/');
    });

    test('should include session ID in SSE URL', async ({ page }) => {
      const sessionId = await chatPage.getSessionId();
      expect(sessionId).toBeTruthy();

      const sseRequest = page.waitForRequest((req) =>
        req.url().includes(`/api/chat/stream/${sessionId}`)
      );

      await chatPage.navigate();

      const request = await sseRequest;
      expect(request.url()).toContain(sessionId!);
    });

    test('should handle SSE connection errors gracefully', async ({ page, context }) => {
      // Simulate network failure
      await mockBackend.mockNetworkError('**/api/chat/stream/**');

      await chatPage.navigate();

      // Page should still be functional
      await expect(chatPage.welcomeScreen).toBeVisible();
      await expect(chatPage.messageInput).toBeEnabled();
    });

    test.skip('should auto-reconnect SSE after disconnect', async ({ page, context }) => {
      // This test requires real backend implementation of auto-reconnect
      // Skip for now as it's complex to mock EventSource reconnection behavior

      await chatPage.navigate();

      // Simulate disconnect by going offline
      await context.setOffline(true);
      await page.waitForTimeout(1000);

      // Go back online
      await context.setOffline(false);

      // Wait for reconnection (5 second retry interval)
      await page.waitForTimeout(6000);

      // Should be able to send message
      await mockBackend.mockHappyPath();
      await chatPage.sendMessage(TEST_MESSAGES.simple);

      await expect(chatPage.userMessages.first()).toBeVisible();
    });
  });

  test.describe('Complete Flow Integration', () => {
    test('should handle complete generation flow', async () => {
      await mockBackend.mockHappyPath();

      await chatPage.sendMessage(TEST_MESSAGES.simple);

      // 1. User message appears
      await chatPage.waitForUserMessage();
      await expect(chatPage.userMessages.first()).toBeVisible();

      // 2. Progress message appears
      await chatPage.waitForProgressMessage();
      await expect(chatPage.progressMessages.first()).toBeVisible();

      // 3. Assistant response appears
      await chatPage.waitForAssistantResponse();
      await expect(chatPage.assistantMessages.first()).toBeVisible();

      // 4. Download button appears
      await chatPage.waitForDownloadButton();
      await expect(chatPage.downloadButton).toBeVisible();

      // 5. Loading state clears
      const isLoading = await chatPage.isLoading();
      expect(isLoading).toBe(false);
    });

    test('should handle multiple message exchanges', async () => {
      await mockBackend.mockHappyPath();

      // First message
      await chatPage.sendMessage('First message');
      await chatPage.waitForAssistantResponse();
      await chatPage.waitForLoadingComplete();

      // Second message
      await chatPage.sendMessage('Second message');
      await chatPage.waitForAssistantResponse(TIMEOUTS.long);

      // Should have 2 user messages and 2+ assistant messages
      const userCount = await chatPage.getUserMessageCount();
      const assistantCount = await chatPage.getAssistantMessageCount();

      expect(userCount).toBe(2);
      expect(assistantCount).toBeGreaterThanOrEqual(2);
    });
  });
});
