import { Controller, Post, Body, Sse, MessageEvent, Param, Get, OnModuleDestroy, Logger } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';
import { map } from 'rxjs/operators';
import { GraphOrchestrationService } from '../orchestration/graph.service';
import { GraphState } from '../orchestration/types';
import { Public } from '../auth/decorators/public.decorator';

interface ChatRequest {
  message: string;
  sessionId: string;
  conversationId?: string;
}

interface StreamUpdate {
  type: 'progress' | 'result' | 'error' | 'complete';
  node?: string;
  message?: string;
  data?: any;
  timestamp: Date;
}

interface BufferedUpdate {
  update: StreamUpdate;
  timestamp: Date;
}

interface StreamSession {
  subject: Subject<StreamUpdate>;
  buffer: BufferedUpdate[];
  createdAt: Date;
  lastActivityAt: Date;
  isGraphExecuting: boolean;
}

@Controller('api/chat')
export class ChatController implements OnModuleDestroy {
  private readonly logger = new Logger(ChatController.name);

  // Session storage with buffering support
  private streamSessions = new Map<string, StreamSession>();

  // Cleanup configuration
  private readonly CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  private readonly SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
  private cleanupTimer: NodeJS.Timeout;

  constructor(private graphService: GraphOrchestrationService) {
    // Start automatic cleanup timer
    this.startCleanupTimer();
  }

  /**
   * SSE endpoint for streaming conversation updates
   * Supports buffering for late-joining observers
   */
  @Sse('stream/:sessionId')
  streamConversation(@Param('sessionId') sessionId: string): Observable<MessageEvent> {
    this.logger.log(`SSE connection established for session: ${sessionId}`);

    // Ensure session exists
    this.ensureSessionExists(sessionId);
    const session = this.streamSessions.get(sessionId);

    // Flush buffered updates immediately when observer connects
    if (session.buffer.length > 0) {
      this.logger.log(`Flushing ${session.buffer.length} buffered updates for session: ${sessionId}`);

      // Schedule buffer flush after Observable subscription
      setTimeout(() => {
        const currentSession = this.streamSessions.get(sessionId);
        if (currentSession) {
          currentSession.buffer.forEach(buffered => {
            currentSession.subject.next(buffered.update);
          });
          currentSession.buffer = []; // Clear buffer after flush
          this.logger.log(`Buffer flushed for session: ${sessionId}`);
        }
      }, 0);
    } else {
      this.logger.log(`No buffered updates for session: ${sessionId}`);
    }

    // Log observer count after subscription
    setTimeout(() => {
      const currentSession = this.streamSessions.get(sessionId);
      if (currentSession) {
        this.logger.log(`Session ${sessionId} observer count: ${currentSession.subject.observers.length}`);
      }
    }, 100);

    return session.subject.asObservable().pipe(
      map((update: StreamUpdate) => ({
        data: JSON.stringify(update),
      })),
    );
  }

  /**
   * POST endpoint to send message and trigger graph execution
   */
  @Post('message')
  async sendMessage(@Body() request: ChatRequest): Promise<{ success: boolean; conversationId: string }> {
    const { message, sessionId, conversationId } = request;
    this.logger.log(`Message received for session: ${sessionId}, conversationId: ${conversationId || 'new'}`);

    // Create session immediately before graph execution
    this.ensureSessionExists(sessionId);

    // Mark graph as executing
    const session = this.streamSessions.get(sessionId);
    session.isGraphExecuting = true;
    session.lastActivityAt = new Date();

    // Execute graph in background and stream updates
    this.executeAndStream(sessionId, message, conversationId).catch(error => {
      this.logger.error(`Graph execution error for session ${sessionId}: ${error.message}`);
      this.sendStreamUpdate(sessionId, {
        type: 'error',
        message: error.message,
        timestamp: new Date(),
      });
    }).finally(() => {
      const currentSession = this.streamSessions.get(sessionId);
      if (currentSession) {
        currentSession.isGraphExecuting = false;
        currentSession.lastActivityAt = new Date();
        this.logger.log(`Graph execution finished for session: ${sessionId}`);
      }
    });

    return {
      success: true,
      conversationId: conversationId || 'new',
    };
  }

  /**
   * Execute graph and stream updates with buffering support
   */
  private async executeAndStream(
    sessionId: string,
    userInput: string,
    conversationId?: string,
  ): Promise<void> {
    this.logger.log(`Starting graph execution for session: ${sessionId}`);

    try {
      // Get stream generator from graph execution
      const streamGenerator = await this.graphService.executeGraph(
        sessionId,
        userInput,
        conversationId,
      );

      // Process each update from the graph
      for await (const update of streamGenerator) {
        this.logger.debug(`Graph update received from node: ${update.currentNode}`);

        // Send progress updates
        if (update.streamingUpdates) {
          const latestUpdate = update.streamingUpdates[update.streamingUpdates.length - 1];
          this.sendStreamUpdate(sessionId, {
            type: 'progress',
            node: latestUpdate.node,
            message: latestUpdate.message,
            timestamp: latestUpdate.timestamp,
          });
        }

        // Send final result if complete
        if (update.isComplete) {
          this.sendStreamUpdate(sessionId, {
            type: 'complete',
            message: update.response,
            data: {
              conversationId: update.conversationId,
              generatedCode: update.generatedCode,
              executionResults: update.executionResults,
            },
            timestamp: new Date(),
          });
        }

        // Send clarification request
        if (update.needsUserInput && update.clarificationNeeded) {
          this.sendStreamUpdate(sessionId, {
            type: 'result',
            message: update.clarificationNeeded.question,
            data: {
              options: update.clarificationNeeded.options,
            },
            timestamp: new Date(),
          });
        }
      }

      this.logger.log(`Graph execution completed successfully for session: ${sessionId}`);
    } catch (error) {
      this.logger.error(`Graph execution failed for session ${sessionId}: ${error.message}`, error.stack);
      this.sendStreamUpdate(sessionId, {
        type: 'error',
        message: `Execution failed: ${error.message}`,
        timestamp: new Date(),
      });
    }
  }

  /**
   * Send update to SSE stream with buffering support
   * If observers are connected, send immediately
   * Otherwise, buffer the update for later delivery
   */
  private sendStreamUpdate(sessionId: string, update: StreamUpdate): void {
    const session = this.streamSessions.get(sessionId);

    if (!session) {
      this.logger.error(`No session found for ${sessionId} - update dropped: ${update.type}`);
      return;
    }

    const observerCount = session.subject.observers.length;
    this.logger.debug(`Sending ${update.type} update to session ${sessionId} (observers: ${observerCount})`);

    if (observerCount > 0) {
      // Direct send - observers are listening
      session.subject.next(update);
      this.logger.debug(`Update sent directly to ${observerCount} observer(s)`);
    } else {
      // Buffer update - no observers yet (defensive)
      this.logger.warn(`No observers for ${sessionId} - buffering ${update.type} update`);
      session.buffer.push({
        update,
        timestamp: new Date(),
      });
    }

    session.lastActivityAt = new Date();
  }

  /**
   * Ensure session exists, create if needed
   */
  private ensureSessionExists(sessionId: string): void {
    if (!this.streamSessions.has(sessionId)) {
      this.logger.log(`Creating new stream session: ${sessionId}`);
      this.streamSessions.set(sessionId, {
        subject: new Subject<StreamUpdate>(),
        buffer: [],
        createdAt: new Date(),
        lastActivityAt: new Date(),
        isGraphExecuting: false,
      });
    }
  }

  /**
   * Start automatic cleanup timer for stale sessions
   */
  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanupStaleSessions();
    }, this.CLEANUP_INTERVAL_MS);

    this.logger.log(`Session cleanup timer started (runs every ${this.CLEANUP_INTERVAL_MS / 60000} minutes)`);
  }

  /**
   * Cleanup stale sessions that have been inactive
   * Does NOT cleanup sessions with active graph execution
   */
  private cleanupStaleSessions(): void {
    const now = new Date();
    let cleanedCount = 0;

    for (const [sessionId, session] of this.streamSessions.entries()) {
      const inactiveMs = now.getTime() - session.lastActivityAt.getTime();

      // Don't cleanup sessions with active graph execution
      if (session.isGraphExecuting) {
        continue;
      }

      // Cleanup sessions inactive for > 30 minutes
      if (inactiveMs > this.SESSION_TIMEOUT_MS) {
        this.logger.log(`Cleaning up stale session: ${sessionId} (inactive for ${Math.round(inactiveMs / 60000)}m)`);
        session.subject.complete();
        this.streamSessions.delete(sessionId);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      this.logger.log(`Cleaned up ${cleanedCount} stale session(s). Active sessions: ${this.streamSessions.size}`);
    } else {
      this.logger.debug(`No stale sessions to cleanup. Active sessions: ${this.streamSessions.size}`);
    }
  }

  /**
   * Cleanup endpoint (optional - for closing streams explicitly)
   */
  @Post('close/:sessionId')
  closeStream(@Param('sessionId') sessionId: string): { success: boolean } {
    const session = this.streamSessions.get(sessionId);
    if (session) {
      this.logger.log(`Closing stream for session: ${sessionId}`);
      session.subject.complete();
      this.streamSessions.delete(sessionId);
    } else {
      this.logger.warn(`Close requested for non-existent session: ${sessionId}`);
    }
    return { success: true };
  }

  /**
   * Health check endpoint
   */
  @Public()
  @Get('health')
  health(): { status: string; timestamp: Date; activeSessions: number } {
    return {
      status: 'ok',
      timestamp: new Date(),
      activeSessions: this.streamSessions.size,
    };
  }

  /**
   * Stop cleanup timer on module destroy
   */
  onModuleDestroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.logger.log('Session cleanup timer stopped');
    }

    // Complete all active sessions
    for (const [sessionId, session] of this.streamSessions.entries()) {
      this.logger.log(`Completing session on shutdown: ${sessionId}`);
      session.subject.complete();
    }
    this.streamSessions.clear();
    this.logger.log('All sessions cleared on module destroy');
  }
}
