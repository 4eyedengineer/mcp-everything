import { Page, Route } from '@playwright/test';
import {
  MOCK_CONVERSATIONS,
  MOCK_MESSAGES,
  MOCK_SSE_EVENTS,
  MOCK_GENERATED_CODE,
  API_ENDPOINTS,
} from './test-data';

/**
 * Mock Backend Fixture for API mocking in tests
 */
export class MockBackend {
  constructor(private page: Page) {}

  /**
   * Mock the chat message API
   */
  async mockChatMessage(response: any = { success: true }): Promise<void> {
    await this.page.route(`**${API_ENDPOINTS.chat.message}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(response),
      });
    });
  }

  /**
   * Mock SSE stream with custom events
   */
  async mockSSEStream(events: any[]): Promise<void> {
    await this.page.route(`**${API_ENDPOINTS.chat.stream('*')}`, async (route) => {
      const sseData = events.map((event) => `data: ${JSON.stringify(event)}`).join('\n\n');

      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        headers: {
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
        body: sseData,
      });
    });
  }

  /**
   * Mock SSE stream with progress -> result -> complete flow
   */
  async mockCompleteSSEFlow(includeCode = true): Promise<void> {
    const events = [
      MOCK_SSE_EVENTS.progress,
      { ...MOCK_SSE_EVENTS.progress, message: 'Generating code...' },
      MOCK_SSE_EVENTS.result,
    ];

    if (includeCode) {
      events.push({
        ...MOCK_SSE_EVENTS.complete,
        data: { generatedCode: MOCK_GENERATED_CODE },
      });
    } else {
      events.push(MOCK_SSE_EVENTS.complete);
    }

    await this.mockSSEStream(events);
  }

  /**
   * Mock SSE stream with error
   */
  async mockSSEError(errorMessage = 'Failed to generate server'): Promise<void> {
    await this.mockSSEStream([
      MOCK_SSE_EVENTS.progress,
      { ...MOCK_SSE_EVENTS.error, message: errorMessage },
    ]);
  }

  /**
   * Mock conversations list API
   */
  async mockConversationsList(conversations = MOCK_CONVERSATIONS): Promise<void> {
    await this.page.route(`**${API_ENDPOINTS.conversations.list}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ conversations }),
      });
    });
  }

  /**
   * Mock conversation creation
   */
  async mockConversationCreate(conversation: any = MOCK_CONVERSATIONS[0]): Promise<void> {
    await this.page.route(`**${API_ENDPOINTS.conversations.create}`, async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify(conversation),
        });
      }
    });
  }

  /**
   * Mock conversation messages
   */
  async mockConversationMessages(conversationId: string, messages = MOCK_MESSAGES): Promise<void> {
    await this.page.route(
      `**${API_ENDPOINTS.conversations.messages(conversationId)}`,
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ messages }),
        });
      }
    );
  }

  /**
   * Mock all conversations API endpoints
   */
  async mockConversationsAPI(): Promise<void> {
    await this.mockConversationsList();
    await this.mockConversationCreate();
    await this.mockConversationMessages('*');
  }

  /**
   * Mock health check endpoint
   */
  async mockHealthCheck(healthy = true): Promise<void> {
    await this.page.route(`**${API_ENDPOINTS.health}`, async (route) => {
      await route.fulfill({
        status: healthy ? 200 : 503,
        contentType: 'application/json',
        body: JSON.stringify({
          status: healthy ? 'ok' : 'error',
          timestamp: new Date().toISOString(),
        }),
      });
    });
  }

  /**
   * Mock network error
   */
  async mockNetworkError(urlPattern: string): Promise<void> {
    await this.page.route(urlPattern, async (route) => {
      await route.abort('failed');
    });
  }

  /**
   * Mock timeout error
   */
  async mockTimeout(urlPattern: string, delay = 30000): Promise<void> {
    await this.page.route(urlPattern, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      await route.abort('timedout');
    });
  }

  /**
   * Mock 500 server error
   */
  async mockServerError(urlPattern: string, message = 'Internal Server Error'): Promise<void> {
    await this.page.route(urlPattern, async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: message }),
      });
    });
  }

  /**
   * Mock 401 unauthorized error
   */
  async mockUnauthorizedError(urlPattern: string): Promise<void> {
    await this.page.route(urlPattern, async (route) => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Unauthorized' }),
      });
    });
  }

  /**
   * Clear all mocked routes
   */
  async clearMocks(): Promise<void> {
    await this.page.unrouteAll();
  }

  /**
   * Mock complete happy path (chat + SSE + conversations)
   */
  async mockHappyPath(): Promise<void> {
    await this.mockChatMessage();
    await this.mockCompleteSSEFlow(true);
    await this.mockConversationsAPI();
    await this.mockHealthCheck();
  }

  /**
   * Intercept and log all API requests
   */
  async logAllRequests(): Promise<void> {
    this.page.on('request', (request) => {
      console.log('→', request.method(), request.url());
    });

    this.page.on('response', (response) => {
      console.log('←', response.status(), response.url());
    });
  }

  /**
   * Wait for specific API call
   */
  async waitForApiCall(urlPattern: string | RegExp, timeout = 10000): Promise<void> {
    await this.page.waitForRequest(urlPattern, { timeout });
  }

  /**
   * Wait for SSE connection
   */
  async waitForSSEConnection(sessionId: string, timeout = 10000): Promise<void> {
    await this.page.waitForRequest(
      (request) =>
        request.url().includes('/api/chat/stream/') && request.url().includes(sessionId),
      { timeout }
    );
  }

  /**
   * Get all requests made to a URL pattern
   */
  async getRequests(urlPattern: string | RegExp): Promise<any[]> {
    return new Promise((resolve) => {
      const requests: any[] = [];
      this.page.on('request', (request) => {
        const url = request.url();
        const matches =
          typeof urlPattern === 'string' ? url.includes(urlPattern) : urlPattern.test(url);
        if (matches) {
          requests.push({
            method: request.method(),
            url: request.url(),
            headers: request.headers(),
            postData: request.postData(),
          });
        }
      });

      setTimeout(() => resolve(requests), 1000);
    });
  }
}
