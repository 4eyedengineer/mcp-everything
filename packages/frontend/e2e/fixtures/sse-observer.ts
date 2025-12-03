// eslint-disable-next-line @typescript-eslint/no-require-imports
const EventSource = require('eventsource');

/**
 * SSE Event structure matching backend StreamUpdate type
 */
export interface SSEEvent {
  type: 'progress' | 'result' | 'complete' | 'error';
  node?: string;
  message?: string;
  data?: any;
  timestamp: Date;
}

/**
 * Complete event with specific data structure
 */
export interface CompleteEvent extends SSEEvent {
  type: 'complete';
  data: {
    conversationId?: string;
    generatedCode?: any;
    deployment?: any;
    tools?: any[];
  };
}

/**
 * Result from phase wait operations
 */
export interface PhaseWaitResult {
  found: boolean;
  event?: SSEEvent;
  allEvents: SSEEvent[];
  duration: number;
}

/**
 * SSE Observer Fixture for monitoring and validating SSE streams in E2E tests
 *
 * This fixture connects directly to the backend SSE endpoint and captures
 * all events for inspection and validation during tests.
 *
 * @example
 * ```typescript
 * const observer = new SSEObserver();
 * await observer.connect(sessionId);
 *
 * // Send a message and wait for phases
 * const result = await observer.waitForProgressContaining('Analyzing intent');
 * expect(result.found).toBe(true);
 *
 * // Wait for completion
 * const complete = await observer.waitForComplete();
 * expect(complete.data.generatedCode).toBeDefined();
 *
 * observer.disconnect();
 * ```
 */
export class SSEObserver {
  private eventSource: EventSource | null = null;
  private events: SSEEvent[] = [];
  private connected: boolean = false;
  private sessionId: string | null = null;
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || process.env['BACKEND_URL'] || 'http://localhost:3000';
  }

  /**
   * Connect to SSE stream for a session
   * @param sessionId - The browser session ID
   */
  async connect(sessionId: string): Promise<void> {
    // Disconnect existing connection if any
    if (this.eventSource) {
      this.disconnect();
    }

    this.sessionId = sessionId;

    return new Promise((resolve, reject) => {
      const url = `${this.baseUrl}/api/chat/stream/${sessionId}`;
      const eventSource = new EventSource(url);
      this.eventSource = eventSource;

      const connectionTimeout = setTimeout(() => {
        if (!this.connected) {
          eventSource.close();
          reject(new Error(`SSE connection timeout for session ${sessionId}`));
        }
      }, 10000);

      eventSource.onopen = () => {
        this.connected = true;
        clearTimeout(connectionTimeout);
        resolve();
      };

      eventSource.onerror = (error: any) => {
        if (!this.connected) {
          clearTimeout(connectionTimeout);
          reject(new Error(`SSE connection failed for session ${sessionId}: ${error.message || 'Unknown error'}`));
        }
        // If already connected, errors are handled silently (reconnection is automatic)
      };

      eventSource.onmessage = (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data);
          this.events.push({
            type: data.type,
            node: data.node,
            message: data.message,
            timestamp: new Date(data.timestamp || Date.now()),
            data: data.data,
          });
        } catch (e) {
          // Ignore parse errors for malformed events
          console.warn('[SSEObserver] Failed to parse event:', event.data);
        }
      };
    });
  }

  /**
   * Disconnect from SSE stream
   */
  disconnect(): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    this.connected = false;
    this.sessionId = null;
    // Note: Do NOT clear events array - tests may need to inspect after disconnect
  }

  /**
   * Check if connected to stream
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Get all received events
   */
  getEvents(): SSEEvent[] {
    return [...this.events];
  }

  /**
   * Get events of a specific type
   */
  getEventsByType(type: SSEEvent['type']): SSEEvent[] {
    return this.events.filter((e) => e.type === type);
  }

  /**
   * Get all progress messages
   */
  getProgressMessages(): string[] {
    return this.events
      .filter((e) => e.type === 'progress' && e.message)
      .map((e) => e.message as string);
  }

  /**
   * Clear recorded events
   */
  clearEvents(): void {
    this.events = [];
  }

  /**
   * Wait for a progress message containing specific text
   * @param text - Text to search for in progress messages (case-insensitive)
   * @param timeout - Timeout in ms (default 60000)
   */
  async waitForProgressContaining(text: string, timeout = 60000): Promise<PhaseWaitResult> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const match = this.events.find(
        (e) => e.type === 'progress' && e.message?.toLowerCase().includes(text.toLowerCase())
      );

      if (match) {
        return {
          found: true,
          event: match,
          allEvents: [...this.events],
          duration: Date.now() - startTime,
        };
      }

      await this.sleep(500);
    }

    return {
      found: false,
      allEvents: [...this.events],
      duration: Date.now() - startTime,
    };
  }

  /**
   * Wait for any of the expected phases
   * @param phases - Array of phase text patterns to wait for (case-insensitive)
   * @param timeout - Timeout in ms per phase (default 60000)
   */
  async waitForPhases(
    phases: string[],
    timeout = 60000
  ): Promise<{
    foundPhases: string[];
    missingPhases: string[];
    allEvents: SSEEvent[];
  }> {
    const foundPhases: string[] = [];
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const progressMessages = this.getProgressMessages();

      for (const phase of phases) {
        if (!foundPhases.includes(phase)) {
          const found = progressMessages.some((msg) =>
            msg.toLowerCase().includes(phase.toLowerCase())
          );
          if (found) {
            foundPhases.push(phase);
          }
        }
      }

      // All phases found
      if (foundPhases.length === phases.length) {
        break;
      }

      await this.sleep(500);
    }

    const missingPhases = phases.filter((p) => !foundPhases.includes(p));

    return {
      foundPhases,
      missingPhases,
      allEvents: [...this.events],
    };
  }

  /**
   * Wait for complete event
   * @param timeout - Timeout in ms (default 300000 - 5 minutes for complex generation)
   */
  async waitForComplete(timeout = 300000): Promise<CompleteEvent> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const completeEvent = this.events.find((e) => e.type === 'complete');

      if (completeEvent) {
        return completeEvent as CompleteEvent;
      }

      await this.sleep(500);
    }

    throw new Error(`Timeout waiting for complete event after ${timeout}ms. Events received: ${JSON.stringify(this.events.map(e => ({ type: e.type, message: e.message })))}`);
  }

  /**
   * Wait for error event
   * @param timeout - Timeout in ms (default 60000)
   */
  async waitForError(timeout = 60000): Promise<SSEEvent> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const errorEvent = this.events.find((e) => e.type === 'error');

      if (errorEvent) {
        return errorEvent;
      }

      await this.sleep(500);
    }

    throw new Error(`Timeout waiting for error event after ${timeout}ms. Events received: ${JSON.stringify(this.events.map(e => ({ type: e.type, message: e.message })))}`);
  }

  /**
   * Wait for any event of specified type
   * @param type - Event type to wait for
   * @param timeout - Timeout in ms (default 60000)
   */
  async waitForEventType(type: SSEEvent['type'], timeout = 60000): Promise<SSEEvent> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const event = this.events.find((e) => e.type === type);

      if (event) {
        return event;
      }

      await this.sleep(500);
    }

    throw new Error(`Timeout waiting for ${type} event after ${timeout}ms. Events received: ${JSON.stringify(this.events.map(e => ({ type: e.type, message: e.message })))}`);
  }

  /**
   * Get the last event of a specific type
   */
  getLastEventOfType(type: SSEEvent['type']): SSEEvent | null {
    const events = this.getEventsByType(type);
    return events.length > 0 ? events[events.length - 1] : null;
  }

  /**
   * Check if a specific phase was received
   * @param text - Text to search for in progress messages (case-insensitive)
   */
  hasPhase(text: string): boolean {
    return this.events.some(
      (e) => e.type === 'progress' && e.message?.toLowerCase().includes(text.toLowerCase())
    );
  }

  /**
   * Private helper to sleep for a given duration
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
