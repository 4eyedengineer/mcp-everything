import { Page, Route } from '@playwright/test';
import {
  MOCK_CONVERSATIONS,
  MOCK_MESSAGES,
  MOCK_SSE_EVENTS,
  MOCK_GENERATED_CODE,
  API_ENDPOINTS,
  MOCK_DEPLOYMENT_RESPONSES,
  MOCK_HOSTED_SERVERS,
  MOCK_SERVER_LOGS,
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

  // ==========================================
  // Deployment API Mocking Methods
  // ==========================================

  /**
   * Mock deploy to GitHub repository
   */
  async mockDeployToGitHub(response: any = MOCK_DEPLOYMENT_RESPONSES.githubSuccess): Promise<void> {
    await this.page.route(`**${API_ENDPOINTS.deploy.github}`, async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({
          status: response.success ? 200 : 400,
          contentType: 'application/json',
          body: JSON.stringify(response),
        });
      }
    });
  }

  /**
   * Mock deploy to Gist
   */
  async mockDeployToGist(response: any = MOCK_DEPLOYMENT_RESPONSES.gistSuccess): Promise<void> {
    await this.page.route(`**${API_ENDPOINTS.deploy.gist}`, async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({
          status: response.success ? 200 : 400,
          contentType: 'application/json',
          body: JSON.stringify(response),
        });
      }
    });
  }

  /**
   * Mock cloud hosting deployment
   */
  async mockHostingDeploy(response: any = MOCK_DEPLOYMENT_RESPONSES.cloudSuccess): Promise<void> {
    await this.page.route('**/api/hosting/deploy/**', async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({
          status: response.success ? 200 : 400,
          contentType: 'application/json',
          body: JSON.stringify(response),
        });
      }
    });
  }

  /**
   * Mock deployment failure
   */
  async mockDeploymentError(error: string = MOCK_DEPLOYMENT_RESPONSES.failure.error): Promise<void> {
    const errorResponse = { success: false, error };
    await this.mockDeployToGitHub(errorResponse);
    await this.mockDeployToGist(errorResponse);
    await this.mockHostingDeploy(errorResponse);
  }

  /**
   * Mock conversation delete
   */
  async mockConversationDelete(conversationId?: string): Promise<void> {
    const pattern = conversationId
      ? `**${API_ENDPOINTS.conversations.delete(conversationId)}`
      : '**/api/conversations/*';

    await this.page.route(pattern, async (route) => {
      if (route.request().method() === 'DELETE') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true }),
        });
      } else {
        await route.continue();
      }
    });
  }

  /**
   * Mock latest deployment for a conversation
   */
  async mockLatestDeployment(conversationId: string, deployment: any = MOCK_DEPLOYMENT_RESPONSES.githubSuccess): Promise<void> {
    await this.page.route(
      `**${API_ENDPOINTS.conversations.latestDeployment(conversationId)}`,
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(deployment),
        });
      }
    );
  }

  // ==========================================
  // Hosting/Server Management Mocking Methods
  // ==========================================

  /**
   * Mock servers list
   */
  async mockServersList(servers: any[] = MOCK_HOSTED_SERVERS): Promise<void> {
    await this.page.route(`**${API_ENDPOINTS.hosting.servers}`, async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            servers,
            pagination: {
              page: 1,
              limit: 20,
              total: servers.length,
              totalPages: 1,
            },
          }),
        });
      } else {
        await route.continue();
      }
    });
  }

  /**
   * Mock empty servers list
   */
  async mockEmptyServersList(): Promise<void> {
    await this.mockServersList([]);
  }

  /**
   * Mock server status
   */
  async mockServerStatus(serverId: string, status: string): Promise<void> {
    await this.page.route(
      `**${API_ENDPOINTS.hosting.serverStatus(serverId)}`,
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status, serverId }),
        });
      }
    );
  }

  /**
   * Mock start server
   */
  async mockStartServer(serverId: string): Promise<void> {
    await this.page.route(
      `**${API_ENDPOINTS.hosting.startServer(serverId)}`,
      async (route) => {
        if (route.request().method() === 'POST') {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ success: true, status: 'running' }),
          });
        }
      }
    );
  }

  /**
   * Mock stop server
   */
  async mockStopServer(serverId: string): Promise<void> {
    await this.page.route(
      `**${API_ENDPOINTS.hosting.stopServer(serverId)}`,
      async (route) => {
        if (route.request().method() === 'POST') {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ success: true, status: 'stopped' }),
          });
        }
      }
    );
  }

  /**
   * Mock delete server
   */
  async mockDeleteServer(serverId: string): Promise<void> {
    await this.page.route(
      `**${API_ENDPOINTS.hosting.server(serverId)}`,
      async (route) => {
        if (route.request().method() === 'DELETE') {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ success: true }),
          });
        } else {
          await route.continue();
        }
      }
    );
  }

  /**
   * Mock server logs
   */
  async mockServerLogs(serverId: string, logs: string[] = MOCK_SERVER_LOGS): Promise<void> {
    await this.page.route(
      `**${API_ENDPOINTS.hosting.serverLogs(serverId)}`,
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ logs }),
        });
      }
    );
  }

  /**
   * Mock all server management APIs
   */
  async mockServersAPI(): Promise<void> {
    await this.mockServersList();

    // Mock start/stop/delete for all mock servers
    for (const server of MOCK_HOSTED_SERVERS) {
      await this.mockStartServer(server.serverId);
      await this.mockStopServer(server.serverId);
      await this.mockDeleteServer(server.serverId);
      await this.mockServerLogs(server.serverId);
      await this.mockServerStatus(server.serverId, server.status);
    }
  }

  /**
   * Mock all deployment APIs (convenience method)
   */
  async mockDeploymentAPIs(): Promise<void> {
    await this.mockDeployToGitHub();
    await this.mockDeployToGist();
    await this.mockHostingDeploy();
    await this.mockServersAPI();
  }

  /**
   * Mock complete happy path including deployment
   */
  async mockHappyPathWithDeployment(): Promise<void> {
    await this.mockHappyPath();
    await this.mockDeploymentAPIs();
  }
}
