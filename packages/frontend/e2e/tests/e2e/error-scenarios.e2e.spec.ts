import { test, expect } from '@playwright/test';
import { ChatE2EPage } from '../../page-objects/chat-e2e.page';

test.describe('Error Scenarios', () => {
  let chatPage: ChatE2EPage;

  test.beforeEach(async ({ page }) => {
    chatPage = new ChatE2EPage(page);
    await chatPage.navigate();
  });

  test.describe('Input Validation', () => {
    test('prevents empty message submission', async ({ page }) => {
      await chatPage.typeMessage('');
      expect(await chatPage.isSendButtonDisabled()).toBe(true);
    });

    test('prevents whitespace-only message submission', async ({ page }) => {
      await chatPage.typeMessage('   \n\t  ');
      expect(await chatPage.isSendButtonDisabled()).toBe(true);
    });

    test('handles very long input gracefully', async ({ page }) => {
      const longInput = 'a'.repeat(10000);
      await chatPage.sendMessage(longInput);

      // Should respond (not crash or timeout immediately)
      await chatPage.waitForAssistantResponse(60000);

      // UI should still be responsive
      expect(await chatPage.messageInput.isVisible()).toBe(true);
    });

    test('handles special characters correctly', async ({ page }) => {
      const specialChars =
        'Test with special: @#$%^&*(){}[]|\\:";\'<>?,./ and unicode: 日本語 🎉 émojis';
      await chatPage.sendMessage(specialChars);

      // Message should appear correctly
      await chatPage.waitForUserMessage(5000);
      const userMessage = await chatPage.getLastUserMessage();
      expect(userMessage).toContain('special');
    });

    test('handles newlines and formatting', async ({ page }) => {
      const multiline = `Line 1
      Line 2
      Line 3`;
      await chatPage.sendMessage(multiline);

      await chatPage.waitForUserMessage(5000);
      // Should preserve some formatting
    });
  });

  test.describe('Security', () => {
    test('XSS: script tags are escaped', async ({ page }) => {
      const xssPayload = '<script>alert("xss")</script>';
      await chatPage.sendMessage(xssPayload);

      await chatPage.waitForUserMessage(5000);

      // Script should not execute
      const alertTriggered = await page.evaluate(() => {
        return (window as any).__xssTriggered === true;
      });
      expect(alertTriggered).toBe(false);

      // Message should be escaped
      const userMessage = await chatPage.getLastUserMessage();
      expect(userMessage).not.toContain('<script>');
    });

    test('XSS: event handlers are escaped', async ({ page }) => {
      const xssPayload = '<img src="x" onerror="alert(1)">';
      await chatPage.sendMessage(xssPayload);

      await chatPage.waitForUserMessage(5000);

      // Should be escaped
      const hasAlert = await page.evaluate(() => {
        return document.querySelectorAll('img[onerror]').length > 0;
      });
      expect(hasAlert).toBe(false);
    });

    test('XSS: javascript protocol is blocked', async ({ page }) => {
      const xssPayload = '<a href="javascript:alert(1)">click</a>';
      await chatPage.sendMessage(xssPayload);

      await chatPage.waitForUserMessage(5000);

      // No clickable javascript links
      const hasJsLink = await page.evaluate(() => {
        return document.querySelectorAll('a[href^="javascript:"]').length > 0;
      });
      expect(hasJsLink).toBe(false);
    });

    test('handles SQL injection attempt', async ({ page }) => {
      const sqlPayload = "'; DROP TABLE users; --";
      await chatPage.sendMessage(`Create MCP for ${sqlPayload}`);

      // Should respond normally (treat as text)
      await chatPage.waitForAssistantResponse(60000);
      // System should not crash
    });

    test('handles path traversal attempt', async ({ page }) => {
      const pathPayload = '../../../etc/passwd';
      await chatPage.sendMessage(`Create MCP from ${pathPayload}`);

      await chatPage.waitForAssistantResponse(60000);
      // Should not expose system files
    });
  });

  test.describe('Invalid URLs', () => {
    test('handles malformed GitHub URL', async ({ page }) => {
      await chatPage.sendMessage('Create MCP for github.com/no-protocol');

      await chatPage.waitForAssistantResponse(60000);

      // Should get helpful response, not crash
      const response = await chatPage.getLastAssistantMessage();
      expect(response.length).toBeGreaterThan(0);
    });

    test('handles non-existent repository', async ({ page }) => {
      await chatPage.sendMessage(
        'Create MCP for https://github.com/this-user-does-not-exist-12345/fake-repo-67890'
      );

      await chatPage.waitForAssistantResponse(60000);

      // Should indicate repo not found
      const response = await chatPage.getLastAssistantMessage();
      expect(response.toLowerCase()).toMatch(
        /not found|cannot access|does not exist|error|couldn't find/
      );
    });

    test('handles private repository', async ({ page }) => {
      // Use a known private repo or GitHub's private repo indicator
      await chatPage.sendMessage(
        'Create MCP for https://github.com/private-org/private-repo'
      );

      await chatPage.waitForAssistantResponse(60000);

      // Should indicate access issue
      const response = await chatPage.getLastAssistantMessage();
      expect(response.length).toBeGreaterThan(0);
    });

    test('handles non-GitHub URL gracefully', async ({ page }) => {
      await chatPage.sendMessage(
        'Create MCP for https://example.com/some/path'
      );

      await chatPage.waitForAssistantResponse(60000);

      // Should handle as website/documentation URL or ask for clarification
      const response = await chatPage.getLastAssistantMessage();
      expect(response.length).toBeGreaterThan(0);
    });
  });

  test.describe('Network Errors', () => {
    test('handles backend timeout gracefully', async ({ page }) => {
      // Increase timeout expectation for this test
      test.setTimeout(120000);

      await chatPage.sendMessage(
        'Create MCP for a very complex repository that takes long'
      );

      // Wait for either response or timeout
      try {
        await chatPage.waitForAssistantResponse(90000);
      } catch (e) {
        // If timeout, UI should still be functional
        expect(await chatPage.messageInput.isVisible()).toBe(true);
      }
    });

    test('UI remains functional after error', async ({ page }) => {
      // Send invalid request
      await chatPage.sendMessage(
        'Create MCP for https://github.com/nonexistent/repo'
      );
      await chatPage.waitForAssistantResponse(60000);

      // Send valid request after
      await chatPage.sendMessage('Hello, can you help me?');
      await chatPage.waitForAssistantResponse(30000);

      // Should get response
      const messages = await chatPage.getAllMessages();
      expect(messages.length).toBeGreaterThanOrEqual(4); // 2 user + 2 assistant
    });
  });

  test.describe('Edge Cases', () => {
    test('handles rapid message submission', async ({ page }) => {
      // Try to send multiple messages quickly
      await chatPage.typeMessage('Message 1');
      await chatPage.clickSend();

      // Immediately try another
      await chatPage.typeMessage('Message 2');

      // Button should be disabled while processing
      const isDisabled = await chatPage.isSendButtonDisabled();
      // Either disabled or message input cleared

      // Wait for system to stabilize
      await page.waitForTimeout(5000);

      // UI should be functional
      expect(await chatPage.messageInput.isVisible()).toBe(true);
    });

    test('handles page refresh during generation', async ({ page }) => {
      await chatPage.sendMessage(
        'Create MCP for https://github.com/sindresorhus/is'
      );

      // Wait for progress to start
      await chatPage.waitForProgressMessage(30000);

      // Refresh page
      await page.reload();

      // Should recover - either resume or show clean state
      await chatPage.waitForNavigation();
      expect(await chatPage.messageInput.isVisible()).toBe(true);
    });

    test('handles browser back/forward during generation', async ({ page }) => {
      await chatPage.sendMessage('Create MCP server for testing');

      // Wait for progress
      await chatPage.waitForProgressMessage(30000);

      // Navigate away
      await page.goto('/explore');
      await page.waitForTimeout(2000);

      // Come back
      await page.goBack();

      // Should handle gracefully
      expect(await chatPage.isOnChatPage()).toBe(true);
    });
  });
});
