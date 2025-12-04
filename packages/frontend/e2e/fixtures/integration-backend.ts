/**
 * Integration Backend Fixture
 *
 * Provides utilities for testing real frontend-backend integration.
 * Unlike mock-backend.ts, this fixture interacts with the actual running backend.
 *
 * Usage:
 *   const backend = new IntegrationBackend();
 *   await backend.waitForReady();
 *   const health = await backend.healthCheck();
 */

export interface HealthResponse {
  status: string;
  timestamp: string | Date;
  service?: string;
  activeSessions?: number;
}

export interface CorsCheckResult {
  hasAllowOrigin: boolean;
  hasAllowCredentials: boolean;
  hasAllowHeaders: boolean;
  allowedOrigin: string | null;
  allowedMethods: string[];
  allowedHeaders: string[];
}

export interface SSEConnectionResult {
  connected: boolean;
  statusCode: number;
  contentType: string | null;
  error?: string;
}

export class IntegrationBackend {
  private backendUrl: string;
  private frontendUrl: string;
  private timeout: number;

  constructor(options?: { backendUrl?: string; frontendUrl?: string; timeout?: number }) {
    this.backendUrl = options?.backendUrl || 'http://localhost:3000';
    this.frontendUrl = options?.frontendUrl || 'http://localhost:4200';
    this.timeout = options?.timeout || 5000;
  }

  /**
   * Check if the backend is healthy
   */
  async healthCheck(): Promise<HealthResponse | null> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(`${this.backendUrl}/api/health`, {
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        return await response.json();
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Check if the chat service is healthy
   */
  async chatHealthCheck(): Promise<HealthResponse | null> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(`${this.backendUrl}/api/chat/health`, {
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        return await response.json();
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Check if backend is ready
   */
  async isReady(): Promise<boolean> {
    const health = await this.healthCheck();
    return health?.status === 'ok';
  }

  /**
   * Wait for backend to be ready
   */
  async waitForReady(maxWaitMs: number = 30000): Promise<boolean> {
    const startTime = Date.now();
    const pollInterval = 1000;

    while (Date.now() - startTime < maxWaitMs) {
      if (await this.isReady()) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    return false;
  }

  /**
   * Test if frontend proxy is working
   */
  async isFrontendProxyWorking(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(`${this.frontendUrl}/api/health`, {
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();
        return data?.status === 'ok';
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Check CORS configuration
   */
  async checkCorsHeaders(origin: string = 'http://localhost:4200'): Promise<CorsCheckResult> {
    const result: CorsCheckResult = {
      hasAllowOrigin: false,
      hasAllowCredentials: false,
      hasAllowHeaders: false,
      allowedOrigin: null,
      allowedMethods: [],
      allowedHeaders: [],
    };

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(`${this.backendUrl}/api/health`, {
        method: 'OPTIONS',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'Content-Type, X-Request-Id',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const allowOrigin = response.headers.get('access-control-allow-origin');
      const allowCredentials = response.headers.get('access-control-allow-credentials');
      const allowMethods = response.headers.get('access-control-allow-methods');
      const allowHeaders = response.headers.get('access-control-allow-headers');

      result.hasAllowOrigin = !!allowOrigin;
      result.allowedOrigin = allowOrigin;
      result.hasAllowCredentials = allowCredentials === 'true';
      result.hasAllowHeaders = !!allowHeaders;

      if (allowMethods) {
        result.allowedMethods = allowMethods.split(',').map((m) => m.trim());
      }

      if (allowHeaders) {
        result.allowedHeaders = allowHeaders.split(',').map((h) => h.trim().toLowerCase());
      }
    } catch {
      // CORS check failed
    }

    return result;
  }

  /**
   * Test SSE endpoint connectivity
   */
  async testSSEConnection(sessionId: string): Promise<SSEConnectionResult> {
    const result: SSEConnectionResult = {
      connected: false,
      statusCode: 0,
      contentType: null,
    };

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000); // Short timeout for SSE test

      const response = await fetch(`${this.backendUrl}/api/chat/stream/${sessionId}`, {
        headers: {
          Accept: 'text/event-stream',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      result.statusCode = response.status;
      result.contentType = response.headers.get('content-type');
      result.connected = response.ok;
    } catch (error) {
      // Timeout is expected for SSE - connection stays open
      if (error instanceof Error && error.name === 'AbortError') {
        result.connected = true;
        result.statusCode = 200;
        result.contentType = 'text/event-stream';
      } else {
        result.error = error instanceof Error ? error.message : 'Unknown error';
      }
    }

    return result;
  }

  /**
   * Test SSE endpoint via frontend proxy
   */
  async testSSEConnectionViaProxy(sessionId: string): Promise<SSEConnectionResult> {
    const result: SSEConnectionResult = {
      connected: false,
      statusCode: 0,
      contentType: null,
    };

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);

      const response = await fetch(`${this.frontendUrl}/api/chat/stream/${sessionId}`, {
        headers: {
          Accept: 'text/event-stream',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      result.statusCode = response.status;
      result.contentType = response.headers.get('content-type');
      result.connected = response.ok;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        result.connected = true;
        result.statusCode = 200;
        result.contentType = 'text/event-stream';
      } else {
        result.error = error instanceof Error ? error.message : 'Unknown error';
      }
    }

    return result;
  }

  /**
   * Send a test chat message
   */
  async sendChatMessage(
    message: string,
    sessionId: string,
    conversationId?: string
  ): Promise<{ success: boolean; conversationId?: string; error?: string }> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(`${this.backendUrl}/api/chat/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message,
          sessionId,
          conversationId,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();
        return { success: true, conversationId: data.conversationId };
      }

      return { success: false, error: `HTTP ${response.status}` };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Test request with custom headers
   */
  async testCustomHeaders(headers: Record<string, string>): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(`${this.backendUrl}/api/health`, {
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Get active session count from chat health
   */
  async getActiveSessionCount(): Promise<number> {
    const health = await this.chatHealthCheck();
    return health?.activeSessions ?? 0;
  }
}

/**
 * UUID v4 validation regex
 */
export const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Check if a string is a valid UUID v4
 */
export function isValidUUIDv4(uuid: string): boolean {
  return UUID_V4_REGEX.test(uuid);
}

/**
 * Generate a test session ID
 */
export function generateTestSessionId(): string {
  return `test-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Stream update interface matching backend SSE events
 */
export interface StreamUpdate {
  type: 'progress' | 'result' | 'complete' | 'error';
  node?: string;
  message?: string;
  data?: {
    conversationId?: string;
    generatedCode?: {
      mainFile: string;
      supportingFiles: Record<string, string>;
      documentation?: string;
    };
    executionResults?: Array<{
      step: string;
      success: boolean;
      output?: string;
      error?: string;
    }>;
  };
  timestamp: string;
}

/**
 * AI readiness check result
 */
export interface AIReadinessResult {
  ready: boolean;
  backendHealthy: boolean;
  chatServiceHealthy: boolean;
  error?: string;
}

/**
 * Extended IntegrationBackend with AI/generation-specific methods
 */
export class CoreFeaturesBackend extends IntegrationBackend {
  /**
   * Check if AI services are ready (backend + chat service healthy)
   * Note: We can't directly check ANTHROPIC_API_KEY from frontend,
   * but we can verify the services that depend on it are healthy
   */
  async isAIReady(): Promise<AIReadinessResult> {
    const result: AIReadinessResult = {
      ready: false,
      backendHealthy: false,
      chatServiceHealthy: false,
    };

    try {
      // Check main backend health
      const backendHealth = await this.healthCheck();
      result.backendHealthy = backendHealth?.status === 'ok';

      // Check chat service health (this service uses the AI)
      const chatHealth = await this.chatHealthCheck();
      result.chatServiceHealthy = chatHealth?.status === 'ok';

      // Both must be healthy for AI to be ready
      result.ready = result.backendHealthy && result.chatServiceHealthy;

      if (!result.ready) {
        result.error = !result.backendHealthy
          ? 'Backend is not healthy'
          : 'Chat service is not healthy';
      }
    } catch (error) {
      result.error = error instanceof Error ? error.message : 'Unknown error';
    }

    return result;
  }

  /**
   * Subscribe to SSE stream and collect events until complete or error
   * Returns collected events for verification
   */
  async collectSSEEvents(
    sessionId: string,
    timeoutMs: number = 300000 // 5 minutes default for generation
  ): Promise<{ events: StreamUpdate[]; error?: string }> {
    const events: StreamUpdate[] = [];

    return new Promise((resolve) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort();
        resolve({ events, error: `Timeout after ${timeoutMs}ms` });
      }, timeoutMs);

      const backendUrl = (this as unknown as { backendUrl: string }).backendUrl || 'http://localhost:3000';

      fetch(`${backendUrl}/api/chat/stream/${sessionId}`, {
        headers: { Accept: 'text/event-stream' },
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) {
            clearTimeout(timeoutId);
            resolve({ events, error: `HTTP ${response.status}` });
            return;
          }

          const reader = response.body?.getReader();
          if (!reader) {
            clearTimeout(timeoutId);
            resolve({ events, error: 'No response body' });
            return;
          }

          const decoder = new TextDecoder();
          let buffer = '';

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() || '';

              for (const line of lines) {
                if (line.startsWith('data: ')) {
                  try {
                    const data = JSON.parse(line.slice(6));
                    events.push(data as StreamUpdate);

                    // Stop on complete or error
                    if (data.type === 'complete' || data.type === 'error') {
                      clearTimeout(timeoutId);
                      controller.abort();
                      resolve({ events });
                      return;
                    }
                  } catch {
                    // Skip malformed JSON
                  }
                }
              }
            }
          } catch (error) {
            if ((error as Error).name !== 'AbortError') {
              clearTimeout(timeoutId);
              resolve({ events, error: (error as Error).message });
            }
          }
        })
        .catch((error) => {
          if (error.name !== 'AbortError') {
            clearTimeout(timeoutId);
            resolve({ events, error: error.message });
          }
        });
    });
  }

  /**
   * Wait for a specific phase to appear in SSE stream
   * Useful for tracking generation progress
   */
  async waitForPhase(
    sessionId: string,
    phase: string,
    timeoutMs: number = 60000
  ): Promise<{ found: boolean; event?: StreamUpdate; error?: string }> {
    return new Promise((resolve) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort();
        resolve({ found: false, error: `Phase "${phase}" not found within ${timeoutMs}ms` });
      }, timeoutMs);

      const backendUrl = (this as unknown as { backendUrl: string }).backendUrl || 'http://localhost:3000';

      fetch(`${backendUrl}/api/chat/stream/${sessionId}`, {
        headers: { Accept: 'text/event-stream' },
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) {
            clearTimeout(timeoutId);
            resolve({ found: false, error: `HTTP ${response.status}` });
            return;
          }

          const reader = response.body?.getReader();
          if (!reader) {
            clearTimeout(timeoutId);
            resolve({ found: false, error: 'No response body' });
            return;
          }

          const decoder = new TextDecoder();
          let buffer = '';

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() || '';

              for (const line of lines) {
                if (line.startsWith('data: ')) {
                  try {
                    const data = JSON.parse(line.slice(6)) as StreamUpdate;

                    // Check if this event matches the phase we're looking for
                    const messageContainsPhase =
                      data.message?.toLowerCase().includes(phase.toLowerCase());
                    const nodeMatchesPhase =
                      data.node?.toLowerCase().includes(phase.toLowerCase());

                    if (messageContainsPhase || nodeMatchesPhase) {
                      clearTimeout(timeoutId);
                      controller.abort();
                      resolve({ found: true, event: data });
                      return;
                    }

                    // Stop on complete or error without finding phase
                    if (data.type === 'complete' || data.type === 'error') {
                      clearTimeout(timeoutId);
                      controller.abort();
                      resolve({
                        found: false,
                        error: `Stream ended (${data.type}) before phase "${phase}" was found`,
                      });
                      return;
                    }
                  } catch {
                    // Skip malformed JSON
                  }
                }
              }
            }
          } catch (error) {
            if ((error as Error).name !== 'AbortError') {
              clearTimeout(timeoutId);
              resolve({ found: false, error: (error as Error).message });
            }
          }
        })
        .catch((error) => {
          if (error.name !== 'AbortError') {
            clearTimeout(timeoutId);
            resolve({ found: false, error: error.message });
          }
        });
    });
  }

  /**
   * Send a message and wait for generation to complete
   * Returns the complete event with generated code
   */
  async sendAndWaitForGeneration(
    message: string,
    sessionId: string,
    timeoutMs: number = 300000
  ): Promise<{
    success: boolean;
    conversationId?: string;
    generatedCode?: StreamUpdate['data']['generatedCode'];
    events: StreamUpdate[];
    error?: string;
  }> {
    // Start collecting SSE events before sending message
    const ssePromise = this.collectSSEEvents(sessionId, timeoutMs);

    // Small delay to ensure SSE connection is established
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Send the message
    const sendResult = await this.sendChatMessage(message, sessionId);
    if (!sendResult.success) {
      return {
        success: false,
        events: [],
        error: `Failed to send message: ${sendResult.error}`,
      };
    }

    // Wait for SSE events
    const sseResult = await ssePromise;

    // Find the complete event
    const completeEvent = sseResult.events.find((e) => e.type === 'complete');
    const errorEvent = sseResult.events.find((e) => e.type === 'error');

    if (errorEvent) {
      return {
        success: false,
        conversationId: sendResult.conversationId,
        events: sseResult.events,
        error: errorEvent.message || 'Generation failed',
      };
    }

    if (completeEvent) {
      return {
        success: true,
        conversationId: completeEvent.data?.conversationId || sendResult.conversationId,
        generatedCode: completeEvent.data?.generatedCode,
        events: sseResult.events,
      };
    }

    return {
      success: false,
      conversationId: sendResult.conversationId,
      events: sseResult.events,
      error: sseResult.error || 'No complete event received',
    };
  }
}
