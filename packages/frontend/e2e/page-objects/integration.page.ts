import { Page, ConsoleMessage, Request, Response } from '@playwright/test';
import { BasePage } from './base.page';
import { isValidUUIDv4 } from '../fixtures/integration-backend';

/**
 * Console error captured during page interaction
 */
export interface CapturedConsoleError {
  message: string;
  type: string;
  location?: string;
  timestamp: Date;
}

/**
 * Network request info for CORS validation
 */
export interface NetworkRequestInfo {
  url: string;
  method: string;
  headers: Record<string, string>;
  status?: number;
  isCorsError: boolean;
  timestamp: Date;
}

/**
 * SSE connection state
 */
export interface SSEConnectionState {
  isConnected: boolean;
  sessionId: string | null;
  messagesReceived: number;
  lastError: string | null;
}

/**
 * Integration Page Object
 *
 * Provides utilities for testing frontend-backend integration.
 * Captures console errors, network requests, and SSE connection state.
 */
export class IntegrationPage extends BasePage {
  private consoleErrors: CapturedConsoleError[] = [];
  private networkRequests: NetworkRequestInfo[] = [];
  private sseState: SSEConnectionState = {
    isConnected: false,
    sessionId: null,
    messagesReceived: 0,
    lastError: null,
  };

  constructor(page: Page) {
    super(page);
    this.setupListeners();
  }

  /**
   * Set up console and network listeners
   */
  private setupListeners(): void {
    // Capture console errors
    this.page.on('console', (msg: ConsoleMessage) => {
      if (msg.type() === 'error') {
        this.consoleErrors.push({
          message: msg.text(),
          type: msg.type(),
          location: msg.location()?.url,
          timestamp: new Date(),
        });
      }
    });

    // Capture network requests for CORS analysis
    this.page.on('requestfailed', (request: Request) => {
      const failure = request.failure();
      const isCorsError = !!(
        failure?.errorText?.includes('CORS') ||
        failure?.errorText?.includes('cross-origin') ||
        failure?.errorText?.includes('Access-Control')
      );

      this.networkRequests.push({
        url: request.url(),
        method: request.method(),
        headers: request.headers(),
        isCorsError,
        timestamp: new Date(),
      });
    });

    this.page.on('response', (response: Response) => {
      const request = response.request();
      this.networkRequests.push({
        url: request.url(),
        method: request.method(),
        headers: request.headers(),
        status: response.status(),
        isCorsError: false,
        timestamp: new Date(),
      });
    });
  }

  /**
   * Navigate to the chat page
   */
  async navigateToChat(): Promise<void> {
    await this.goto('/chat');
    await this.waitForAngular();
  }

  /**
   * Get the session ID from localStorage
   */
  async getLocalStorageSessionId(): Promise<string | null> {
    return this.page.evaluate(() => localStorage.getItem('mcp-session-id'));
  }

  /**
   * Clear the session ID from localStorage
   */
  async clearSessionId(): Promise<void> {
    await this.page.evaluate(() => localStorage.removeItem('mcp-session-id'));
  }

  /**
   * Check if the session ID is a valid UUID v4
   */
  async isSessionIdValidUUID(): Promise<boolean> {
    const sessionId = await this.getLocalStorageSessionId();
    if (!sessionId) return false;
    return isValidUUIDv4(sessionId);
  }

  /**
   * Get all captured console errors
   */
  getConsoleErrors(): CapturedConsoleError[] {
    return [...this.consoleErrors];
  }

  /**
   * Clear captured console errors
   */
  clearConsoleErrors(): void {
    this.consoleErrors = [];
  }

  /**
   * Check if there are any console errors
   */
  hasConsoleErrors(): boolean {
    return this.consoleErrors.length > 0;
  }

  /**
   * Get console errors containing specific text
   */
  getConsoleErrorsContaining(text: string): CapturedConsoleError[] {
    return this.consoleErrors.filter((e) => e.message.toLowerCase().includes(text.toLowerCase()));
  }

  /**
   * Get all network requests
   */
  getNetworkRequests(): NetworkRequestInfo[] {
    return [...this.networkRequests];
  }

  /**
   * Clear network request log
   */
  clearNetworkRequests(): void {
    this.networkRequests = [];
  }

  /**
   * Check if any CORS errors occurred
   */
  hasCorsErrors(): boolean {
    return this.networkRequests.some((r) => r.isCorsError);
  }

  /**
   * Get all CORS error requests
   */
  getCorsErrors(): NetworkRequestInfo[] {
    return this.networkRequests.filter((r) => r.isCorsError);
  }

  /**
   * Get requests to a specific endpoint pattern
   */
  getRequestsToEndpoint(pattern: string | RegExp): NetworkRequestInfo[] {
    return this.networkRequests.filter((r) => {
      if (typeof pattern === 'string') {
        return r.url.includes(pattern);
      }
      return pattern.test(r.url);
    });
  }

  /**
   * Wait for a request to a specific endpoint
   */
  async waitForRequestToEndpoint(
    pattern: string | RegExp,
    timeout: number = 10000
  ): Promise<NetworkRequestInfo | null> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      const requests = this.getRequestsToEndpoint(pattern);
      if (requests.length > 0) {
        return requests[requests.length - 1];
      }
      await this.wait(100);
    }
    return null;
  }

  /**
   * Check SSE connection state via browser evaluation
   */
  async getSSEConnectionState(): Promise<SSEConnectionState> {
    const state = await this.page.evaluate(() => {
      // Access the Angular component's eventSource if possible
      // This is a simplified check - in real implementation, we'd check the actual EventSource
      const sseRequests = (window as any).__sseConnectionState;
      return sseRequests || null;
    });

    if (state) {
      this.sseState = state;
    }

    return this.sseState;
  }

  /**
   * Check if there's an SSE connection in the network requests
   */
  hasSSEConnection(): boolean {
    return this.networkRequests.some(
      (r) => r.url.includes('/api/chat/stream/') && (r.status === 200 || r.status === undefined)
    );
  }

  /**
   * Get SSE connection requests
   */
  getSSEConnectionRequests(): NetworkRequestInfo[] {
    return this.networkRequests.filter((r) => r.url.includes('/api/chat/stream/'));
  }

  /**
   * Wait for SSE connection to be established
   */
  async waitForSSEConnection(timeout: number = 10000): Promise<boolean> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      if (this.hasSSEConnection()) {
        return true;
      }
      await this.wait(100);
    }
    return false;
  }

  /**
   * Trigger a backend error by making a request to a non-existent endpoint
   */
  async triggerBackendError(): Promise<void> {
    await this.page.evaluate(() => {
      fetch('/api/nonexistent-endpoint-for-testing').catch(() => {
        // Expected to fail
      });
    });
  }

  /**
   * Make an API call from the browser and get the response
   */
  async makeApiCall(
    endpoint: string,
    options?: { method?: string; headers?: Record<string, string>; body?: any }
  ): Promise<{ status: number; data: any; headers: Record<string, string> }> {
    return this.page.evaluate(
      async ({ endpoint, options }) => {
        const response = await fetch(endpoint, {
          method: options?.method || 'GET',
          headers: {
            'Content-Type': 'application/json',
            ...(options?.headers || {}),
          },
          body: options?.body ? JSON.stringify(options.body) : undefined,
        });

        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          headers[key] = value;
        });

        let data;
        try {
          data = await response.json();
        } catch {
          data = await response.text();
        }

        return { status: response.status, data, headers };
      },
      { endpoint, options }
    );
  }

  /**
   * Check if the page has Angular errors
   */
  async hasAngularErrors(): Promise<boolean> {
    const angularErrors = this.consoleErrors.filter(
      (e) =>
        e.message.includes('Angular') ||
        e.message.includes('NG0') ||
        e.message.includes('ExpressionChangedAfterItHasBeenCheckedError')
    );
    return angularErrors.length > 0;
  }

  /**
   * Get API health response from browser context
   */
  async getApiHealthFromBrowser(): Promise<any> {
    const result = await this.makeApiCall('/api/health');
    return result.data;
  }

  /**
   * Get chat health response from browser context
   */
  async getChatHealthFromBrowser(): Promise<any> {
    const result = await this.makeApiCall('/api/chat/health');
    return result.data;
  }

  /**
   * Check if error notification is displayed
   */
  async isErrorNotificationVisible(): Promise<boolean> {
    const errorNotification = this.page.locator('[data-testid="error-notification"]');
    const snackBar = this.page.locator('.mat-snack-bar-container');
    const toastError = this.page.locator('.toast-error, .notification-error');

    return (
      (await errorNotification.isVisible().catch(() => false)) ||
      (await snackBar.isVisible().catch(() => false)) ||
      (await toastError.isVisible().catch(() => false))
    );
  }

  /**
   * Get error notification text if visible
   */
  async getErrorNotificationText(): Promise<string | null> {
    const selectors = [
      '[data-testid="error-notification"]',
      '.mat-snack-bar-container',
      '.toast-error',
      '.notification-error',
    ];

    for (const selector of selectors) {
      const element = this.page.locator(selector);
      if (await element.isVisible().catch(() => false)) {
        return await element.textContent();
      }
    }

    return null;
  }

  /**
   * Check page has loaded without critical errors
   */
  async isPageHealthy(): Promise<boolean> {
    const hasAngularErrors = await this.hasAngularErrors();
    const hasCors = this.hasCorsErrors();
    const criticalErrors = this.consoleErrors.filter(
      (e) =>
        e.message.includes('Uncaught') ||
        e.message.includes('TypeError') ||
        e.message.includes('ReferenceError')
    );

    return !hasAngularErrors && !hasCors && criticalErrors.length === 0;
  }

  /**
   * Reset all captured state
   */
  reset(): void {
    this.consoleErrors = [];
    this.networkRequests = [];
    this.sseState = {
      isConnected: false,
      sessionId: null,
      messagesReceived: 0,
      lastError: null,
    };
  }
}
