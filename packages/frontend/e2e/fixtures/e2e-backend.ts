/**
 * E2E Backend Fixture for interacting with the real backend API during E2E tests
 *
 * Unlike MockBackend which intercepts and mocks responses, this fixture makes
 * actual HTTP calls to the backend for integration testing.
 */

// ============================================================================
// Interfaces
// ============================================================================

export interface ChatResponse {
  success: boolean;
  conversationId: string;
}

export interface DeploymentStatus {
  status: 'pending' | 'building' | 'deploying' | 'running' | 'failed';
  serverId?: string;
  endpoint?: string;
  error?: string;
}

export interface DeploymentResult {
  success: boolean;
  serverId: string;
  endpoint: string;
  deploymentId: string;
}

export interface HealthStatus {
  status: string;
  timestamp: string;
  activeSessions?: number;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationMessage {
  id: string;
  conversationId: string;
  content: string;
  role: 'user' | 'assistant';
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface ConversationDetails {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages?: ConversationMessage[];
}

// ============================================================================
// E2EBackendFixture Class
// ============================================================================

export class E2EBackendFixture {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || process.env.BACKEND_URL || 'http://localhost:3000';
  }

  /**
   * Check if backend is healthy
   */
  async healthCheck(): Promise<HealthStatus> {
    const url = `${this.baseUrl}/api/chat/health`;
    const response = await fetch(url);

    if (!response.ok) {
      const error = await this.getErrorText(response);
      throw new Error(`Health check failed: ${response.status} at ${url} - ${error}`);
    }

    return response.json();
  }

  /**
   * Check if backend is ready (health returns 200)
   */
  async isReady(): Promise<boolean> {
    try {
      const health = await this.healthCheck();
      return health.status === 'ok';
    } catch {
      return false;
    }
  }

  /**
   * Wait for backend to be ready with retry
   * @param timeout - Maximum time to wait in ms (default 30000)
   * @param interval - Time between retries in ms (default 1000)
   */
  async waitForReady(timeout = 30000, interval = 1000): Promise<boolean> {
    const start = Date.now();

    while (Date.now() - start < timeout) {
      if (await this.isReady()) {
        return true;
      }
      await this.sleep(interval);
    }

    return false;
  }

  /**
   * Send a chat message
   * @param message - The message to send
   * @param sessionId - Browser session ID
   * @param conversationId - Optional existing conversation ID
   */
  async sendChatMessage(
    message: string,
    sessionId: string,
    conversationId?: string
  ): Promise<ChatResponse> {
    const url = `${this.baseUrl}/api/chat/message`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, sessionId, conversationId }),
    });

    if (!response.ok) {
      const error = await this.getErrorText(response);
      throw new Error(`Send chat message failed: ${response.status} at ${url} - ${error}`);
    }

    return response.json();
  }

  /**
   * Get deployment status for a server
   * @param serverId - The server ID to check status for
   */
  async getDeploymentStatus(serverId: string): Promise<DeploymentStatus> {
    const url = `${this.baseUrl}/api/hosting/servers/${serverId}/status`;

    const response = await fetch(url);

    if (!response.ok) {
      const error = await this.getErrorText(response);
      throw new Error(`Get deployment status failed: ${response.status} at ${url} - ${error}`);
    }

    const data = await response.json();
    return {
      status: data.status,
      serverId: data.serverId,
      endpoint: data.endpointUrl,
      error: data.error,
    };
  }

  /**
   * Deploy a generated MCP server to KinD
   * @param conversationId - The conversation with generated server
   */
  async deployToKinD(conversationId: string): Promise<DeploymentResult> {
    const url = `${this.baseUrl}/api/hosting/deploy/${conversationId}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'kind' }),
    });

    if (!response.ok) {
      const error = await this.getErrorText(response);
      throw new Error(`Deploy to KinD failed: ${response.status} at ${url} - ${error}`);
    }

    const data = await response.json();
    return {
      success: data.success,
      serverId: data.serverId,
      endpoint: data.endpointUrl,
      deploymentId: data.id || data.serverId,
    };
  }

  /**
   * Wait for deployment to reach a specific status
   * @param serverId - The server ID to monitor
   * @param targetStatus - Status to wait for
   * @param timeout - Timeout in ms (default 120000)
   */
  async waitForDeploymentStatus(
    serverId: string,
    targetStatus: DeploymentStatus['status'],
    timeout = 120000
  ): Promise<DeploymentStatus> {
    const start = Date.now();
    const pollInterval = 2000; // Poll every 2 seconds

    while (Date.now() - start < timeout) {
      const status = await this.getDeploymentStatus(serverId);

      // Return if we reached target status or failed
      if (status.status === targetStatus) {
        return status;
      }

      // Early exit on failure (unless we're waiting for failure)
      if (status.status === 'failed' && targetStatus !== 'failed') {
        throw new Error(
          `Deployment failed while waiting for '${targetStatus}': ${status.error || 'Unknown error'}`
        );
      }

      await this.sleep(pollInterval);
    }

    const elapsed = Date.now() - start;
    throw new Error(
      `Timeout waiting for deployment status '${targetStatus}' after ${elapsed}ms (server: ${serverId})`
    );
  }

  /**
   * Get conversation details
   * @param conversationId - The conversation ID
   */
  async getConversation(conversationId: string): Promise<ConversationDetails> {
    const url = `${this.baseUrl}/api/conversations/${conversationId}`;

    const response = await fetch(url);

    if (!response.ok) {
      const error = await this.getErrorText(response);
      throw new Error(`Get conversation failed: ${response.status} at ${url} - ${error}`);
    }

    return response.json();
  }

  /**
   * List all conversations for a session
   * @param sessionId - The session ID to filter by (optional)
   */
  async listConversations(sessionId?: string): Promise<Conversation[]> {
    let url = `${this.baseUrl}/api/conversations`;
    if (sessionId) {
      url += `?sessionId=${encodeURIComponent(sessionId)}`;
    }

    const response = await fetch(url);

    if (!response.ok) {
      const error = await this.getErrorText(response);
      throw new Error(`List conversations failed: ${response.status} at ${url} - ${error}`);
    }

    const data = await response.json();
    // API may return { conversations: [...] } or just [...]
    return Array.isArray(data) ? data : data.conversations || [];
  }

  /**
   * Validate Claude API key is configured
   * Sends a simple message and checks for API key errors
   * @param sessionId - Session ID to use for the test
   */
  async validateClaudeApiKey(sessionId?: string): Promise<boolean> {
    const testSessionId = sessionId || `api-key-test-${Date.now()}`;

    try {
      // Send a simple test message
      const result = await this.sendChatMessage(
        'Hello, this is a test message to validate the API key.',
        testSessionId
      );

      // If we got a conversationId, the API is working
      return result.success && !!result.conversationId;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Check for common API key error indicators
      const apiKeyErrors = [
        'api key',
        'API_KEY',
        'anthropic',
        'unauthorized',
        'authentication',
        'invalid key',
        'missing key',
      ];

      const isApiKeyError = apiKeyErrors.some((indicator) =>
        errorMessage.toLowerCase().includes(indicator.toLowerCase())
      );

      if (isApiKeyError) {
        return false;
      }

      // Re-throw non-API-key errors
      throw error;
    }
  }

  /**
   * Get server details by ID
   * @param serverId - The server ID
   */
  async getServer(serverId: string): Promise<Record<string, unknown>> {
    const url = `${this.baseUrl}/api/hosting/servers/${serverId}`;

    const response = await fetch(url);

    if (!response.ok) {
      const error = await this.getErrorText(response);
      throw new Error(`Get server failed: ${response.status} at ${url} - ${error}`);
    }

    return response.json();
  }

  /**
   * List all hosted servers
   * @param options - Filter options (status, page, limit)
   */
  async listServers(options?: {
    status?: string;
    page?: number;
    limit?: number;
  }): Promise<{ servers: Record<string, unknown>[]; pagination: Record<string, unknown> }> {
    const params = new URLSearchParams();
    if (options?.status) params.set('status', options.status);
    if (options?.page) params.set('page', options.page.toString());
    if (options?.limit) params.set('limit', options.limit.toString());

    const queryString = params.toString();
    const url = `${this.baseUrl}/api/hosting/servers${queryString ? `?${queryString}` : ''}`;

    const response = await fetch(url);

    if (!response.ok) {
      const error = await this.getErrorText(response);
      throw new Error(`List servers failed: ${response.status} at ${url} - ${error}`);
    }

    return response.json();
  }

  /**
   * Stop a hosted server
   * @param serverId - The server ID to stop
   */
  async stopServer(serverId: string): Promise<{ success: boolean; message: string }> {
    const url = `${this.baseUrl}/api/hosting/servers/${serverId}/stop`;

    const response = await fetch(url, {
      method: 'POST',
    });

    if (!response.ok) {
      const error = await this.getErrorText(response);
      throw new Error(`Stop server failed: ${response.status} at ${url} - ${error}`);
    }

    return response.json();
  }

  /**
   * Start a stopped server
   * @param serverId - The server ID to start
   */
  async startServer(serverId: string): Promise<{ success: boolean; message: string }> {
    const url = `${this.baseUrl}/api/hosting/servers/${serverId}/start`;

    const response = await fetch(url, {
      method: 'POST',
    });

    if (!response.ok) {
      const error = await this.getErrorText(response);
      throw new Error(`Start server failed: ${response.status} at ${url} - ${error}`);
    }

    return response.json();
  }

  /**
   * Delete a hosted server
   * @param serverId - The server ID to delete
   */
  async deleteServer(serverId: string): Promise<{ success: boolean; message: string }> {
    const url = `${this.baseUrl}/api/hosting/servers/${serverId}`;

    const response = await fetch(url, {
      method: 'DELETE',
    });

    if (!response.ok) {
      const error = await this.getErrorText(response);
      throw new Error(`Delete server failed: ${response.status} at ${url} - ${error}`);
    }

    return response.json();
  }

  // ============================================================================
  // Private Helper Methods
  // ============================================================================

  /**
   * Extract error text from a failed response
   */
  private async getErrorText(response: Response): Promise<string> {
    try {
      const data = await response.json();
      return data.message || data.error || JSON.stringify(data);
    } catch {
      try {
        return await response.text();
      } catch {
        return 'Unknown error';
      }
    }
  }

  /**
   * Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
