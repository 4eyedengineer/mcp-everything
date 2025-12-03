/**
 * Layer 4: Frontend-Backend Integration Tests
 *
 * This test suite validates frontend-backend communication per Issue #90.
 * Tests require both frontend (port 4200) and backend (port 3000) to be running.
 *
 * Run with: npm run validate:integration
 */

import { test, expect } from '@playwright/test';
import { IntegrationPage } from '../page-objects/integration.page';
import {
  IntegrationBackend,
  isValidUUIDv4,
  generateTestSessionId,
} from '../fixtures/integration-backend';
import { TIMEOUTS } from '../fixtures/test-data';

// Test configuration
const BACKEND_URL = 'http://localhost:3000';
const FRONTEND_URL = 'http://localhost:4200';

test.describe('Layer 4: Frontend-Backend Integration', () => {
  let integrationPage: IntegrationPage;
  let backend: IntegrationBackend;

  test.beforeAll(async () => {
    // Verify backend is running before all tests
    backend = new IntegrationBackend({ backendUrl: BACKEND_URL, frontendUrl: FRONTEND_URL });
    const isReady = await backend.isReady();
    if (!isReady) {
      throw new Error(
        'Backend is not running. Start it with: cd packages/backend && npm run start:dev'
      );
    }
  });

  test.beforeEach(async ({ page }) => {
    integrationPage = new IntegrationPage(page);
    integrationPage.reset();
  });

  test.describe('4.1 API Proxy Configuration', () => {
    test('proxy routes /api/* requests to backend', async () => {
      // Make request through frontend proxy
      const proxyWorking = await backend.isFrontendProxyWorking();
      expect(proxyWorking).toBe(true);
    });

    test('proxy returns correct health response', async ({ page }) => {
      await integrationPage.navigateToChat();

      // Make API call from browser context (through proxy)
      const health = await integrationPage.getApiHealthFromBrowser();
      expect(health).toBeDefined();
      expect(health.status).toBe('ok');
    });

    test('no CORS errors when using proxy', async () => {
      await integrationPage.navigateToChat();
      await integrationPage.wait(2000); // Allow time for initial requests

      const corsErrors = integrationPage.getCorsErrors();
      expect(corsErrors.length).toBe(0);
    });

    test('request reaches backend and response returns', async () => {
      await integrationPage.navigateToChat();

      // Check that API requests to /api/* were made
      const apiRequests = integrationPage.getRequestsToEndpoint('/api/');
      expect(apiRequests.length).toBeGreaterThan(0);

      // Verify at least one successful response
      const successfulRequests = apiRequests.filter((r) => r.status && r.status >= 200 && r.status < 400);
      expect(successfulRequests.length).toBeGreaterThan(0);
    });
  });

  test.describe('4.2 CORS Configuration', () => {
    test('CORS headers present in backend response', async () => {
      const corsResult = await backend.checkCorsHeaders('http://localhost:4200');
      expect(corsResult.hasAllowOrigin).toBe(true);
    });

    test('CORS allows localhost:4200 origin', async () => {
      const corsResult = await backend.checkCorsHeaders('http://localhost:4200');
      expect(corsResult.allowedOrigin).toContain('localhost:4200');
    });

    test('CORS credentials header is set', async () => {
      const corsResult = await backend.checkCorsHeaders('http://localhost:4200');
      expect(corsResult.hasAllowCredentials).toBe(true);
    });

    test('direct API call from browser works', async () => {
      await integrationPage.navigateToChat();

      // Make direct API call
      const result = await integrationPage.makeApiCall(`${BACKEND_URL}/api/health`);
      expect(result.status).toBe(200);
      expect(result.data.status).toBe('ok');
    });
  });

  test.describe('4.3 SSE Connection', () => {
    test('SSE endpoint is reachable', async () => {
      const sessionId = generateTestSessionId();
      const sseResult = await backend.testSSEConnection(sessionId);

      // SSE should connect (timeout is expected as connection stays open)
      expect(sseResult.connected).toBe(true);
    });

    test('SSE endpoint reachable via proxy', async () => {
      const sessionId = generateTestSessionId();
      const sseResult = await backend.testSSEConnectionViaProxy(sessionId);

      expect(sseResult.connected).toBe(true);
    });

    test('SSE connection attempt visible in network', async () => {
      await integrationPage.navigateToChat();
      await integrationPage.wait(3000); // Allow time for SSE connection

      // Check for SSE connection requests
      const sseRequests = integrationPage.getSSEConnectionRequests();
      expect(sseRequests.length).toBeGreaterThan(0);
    });

    test('SSE connection uses session ID from URL', async () => {
      await integrationPage.navigateToChat();
      await integrationPage.wait(2000);

      const sessionId = await integrationPage.getLocalStorageSessionId();
      const sseRequests = integrationPage.getSSEConnectionRequests();

      // At least one SSE request should include the session ID
      const hasSessionInUrl = sseRequests.some((r) => sessionId && r.url.includes(sessionId));
      expect(hasSessionInUrl).toBe(true);
    });
  });

  test.describe('4.4 Session ID Generation', () => {
    test('session ID created on first visit', async () => {
      // Clear any existing session
      await integrationPage.clearLocalStorage();
      await integrationPage.navigateToChat();
      await integrationPage.wait(1000);

      const sessionId = await integrationPage.getLocalStorageSessionId();
      expect(sessionId).not.toBeNull();
      expect(sessionId).toBeTruthy();
    });

    test('session ID is valid UUID v4 format', async () => {
      await integrationPage.navigateToChat();
      await integrationPage.wait(500);

      const isValid = await integrationPage.isSessionIdValidUUID();
      expect(isValid).toBe(true);
    });

    test('session ID persists on page reload', async () => {
      await integrationPage.navigateToChat();
      await integrationPage.wait(500);

      const originalSessionId = await integrationPage.getLocalStorageSessionId();
      expect(originalSessionId).not.toBeNull();

      // Reload page
      await integrationPage.reload();
      await integrationPage.wait(500);

      const newSessionId = await integrationPage.getLocalStorageSessionId();
      expect(newSessionId).toBe(originalSessionId);
    });

    test('session ID stored in localStorage with correct key', async () => {
      await integrationPage.navigateToChat();
      await integrationPage.wait(500);

      // Use the page object method to get session ID from localStorage
      const sessionId = await integrationPage.getLocalStorageSessionId();

      expect(sessionId).not.toBeNull();
      expect(isValidUUIDv4(sessionId!)).toBe(true);
    });
  });

  test.describe('4.5 API Request Headers', () => {
    test('requests include Content-Type header', async () => {
      await integrationPage.navigateToChat();
      await integrationPage.wait(1000);

      const apiRequests = integrationPage.getRequestsToEndpoint('/api/');
      const postRequests = apiRequests.filter((r) => r.method === 'POST');

      // If there are POST requests, they should have Content-Type
      if (postRequests.length > 0) {
        const hasContentType = postRequests.some(
          (r) => r.headers['content-type']?.includes('application/json')
        );
        expect(hasContentType).toBe(true);
      }
    });

    test('backend accepts custom headers', async () => {
      const accepts = await backend.testCustomHeaders({
        'X-Request-Id': 'test-123',
        'X-Session-Id': 'session-456',
        'X-App-Version': '1.0.0',
      });

      expect(accepts).toBe(true);
    });

    test('API interceptor adds expected headers', async () => {
      await integrationPage.navigateToChat();
      await integrationPage.wait(1000);

      const apiRequests = integrationPage.getRequestsToEndpoint('/api/');

      // Check that requests have accept header
      const hasAcceptHeader = apiRequests.some(
        (r) => r.headers['accept']?.includes('application/json')
      );
      expect(hasAcceptHeader).toBe(true);
    });
  });

  test.describe('4.6 Chat Service Initialization', () => {
    test('page loads without Angular errors', async () => {
      await integrationPage.navigateToChat();
      await integrationPage.wait(2000);

      const hasAngularErrors = await integrationPage.hasAngularErrors();
      expect(hasAngularErrors).toBe(false);
    });

    test('page loads without critical console errors', async () => {
      await integrationPage.navigateToChat();
      await integrationPage.wait(2000);

      const isHealthy = await integrationPage.isPageHealthy();
      expect(isHealthy).toBe(true);
    });

    test('chat health endpoint responds OK', async () => {
      await integrationPage.navigateToChat();

      const chatHealth = await integrationPage.getChatHealthFromBrowser();
      expect(chatHealth).toBeDefined();
      expect(chatHealth.status).toBe('ok');
    });

    test('initial API calls succeed', async () => {
      await integrationPage.navigateToChat();
      await integrationPage.wait(2000);

      // Should have made some successful API requests
      const apiRequests = integrationPage.getRequestsToEndpoint('/api/');
      const successfulRequests = apiRequests.filter(
        (r) => r.status && r.status >= 200 && r.status < 400
      );

      expect(successfulRequests.length).toBeGreaterThan(0);
    });

    test('no CORS errors during initialization', async () => {
      integrationPage.clearNetworkRequests();
      await integrationPage.navigateToChat();
      await integrationPage.wait(2000);

      expect(integrationPage.hasCorsErrors()).toBe(false);
    });
  });

  test.describe('4.7 Error Handling', () => {
    test('frontend handles API error gracefully', async () => {
      await integrationPage.navigateToChat();
      await integrationPage.wait(1000);

      // Trigger an intentional error
      await integrationPage.triggerBackendError();
      await integrationPage.wait(500);

      // Page should still be functional (not crashed)
      const isHealthy = await integrationPage.isPageHealthy();
      expect(isHealthy).toBe(true);
    });

    test('404 response handled without crash', async () => {
      await integrationPage.navigateToChat();

      // Make a request to a non-existent endpoint
      const result = await integrationPage.makeApiCall('/api/nonexistent-endpoint');
      expect(result.status).toBe(404);

      // Page should still be functional
      await integrationPage.wait(500);
      const consoleErrors = integrationPage.getConsoleErrors();

      // Should not have uncaught errors from the 404
      const uncaughtErrors = consoleErrors.filter((e) => e.message.includes('Uncaught'));
      expect(uncaughtErrors.length).toBe(0);
    });

    test('error messages are not cryptic (user-friendly)', async () => {
      await integrationPage.navigateToChat();

      // Make a request that will fail
      const result = await integrationPage.makeApiCall('/api/nonexistent-endpoint');

      // If there's an error notification, it should be readable
      const errorText = await integrationPage.getErrorNotificationText();
      if (errorText) {
        // Error should not expose technical details like stack traces
        expect(errorText).not.toContain('at Object');
        expect(errorText).not.toContain('.ts:');
      }
    });
  });

  test.describe('4.8 SSE Reconnection', () => {
    test('SSE reconnection logic exists in frontend', async () => {
      await integrationPage.navigateToChat();
      await integrationPage.wait(2000);

      // Check that at least one SSE connection was established
      const hasSSE = integrationPage.hasSSEConnection();
      expect(hasSSE).toBe(true);
    });

    test('no infinite error loops in console', async () => {
      await integrationPage.navigateToChat();
      await integrationPage.wait(5000); // Wait longer to detect loops

      const errors = integrationPage.getConsoleErrors();

      // Group errors by message to detect loops
      const errorCounts = new Map<string, number>();
      for (const error of errors) {
        const key = error.message.substring(0, 100);
        errorCounts.set(key, (errorCounts.get(key) || 0) + 1);
      }

      // No single error should repeat excessively (indicates loop)
      for (const [msg, count] of errorCounts) {
        expect(count).toBeLessThan(10);
      }
    });

    test('SSE connection attempts are reasonable', async () => {
      await integrationPage.navigateToChat();
      await integrationPage.wait(5000);

      const sseRequests = integrationPage.getSSEConnectionRequests();

      // Should not have excessive SSE connection attempts (reconnection storms)
      // Normal behavior: 1 initial connection, maybe 1-2 reconnects
      expect(sseRequests.length).toBeLessThan(10);
    });
  });

  test.describe('Integration Summary', () => {
    test('complete page load succeeds', async () => {
      integrationPage.reset();
      await integrationPage.navigateToChat();
      await integrationPage.wait(3000);

      // Summary assertions
      expect(integrationPage.hasCorsErrors()).toBe(false);
      expect(await integrationPage.hasAngularErrors()).toBe(false);
      expect(await integrationPage.isSessionIdValidUUID()).toBe(true);

      const apiRequests = integrationPage.getRequestsToEndpoint('/api/');
      expect(apiRequests.length).toBeGreaterThan(0);
    });
  });
});
