import {
  Controller,
  Post,
  Body,
  Sse,
  MessageEvent,
  Param,
  Query,
  Get,
  OnModuleDestroy,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Observable, Subject } from 'rxjs';
import { map } from 'rxjs/operators';
import { GenerationPipeline } from '../orchestration/pipeline.service';
import { Public } from '../auth/decorators/public.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../database/entities/user.entity';
import { StreamTicketService } from './stream-ticket.service';
import { CreateStreamTicketDto, StreamTicketResponseDto } from './dto/stream-ticket.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { PipelineStatusService } from './pipeline-status.service';

interface StreamUpdate {
  type: 'progress' | 'result' | 'error' | 'complete';
  node?: string;
  message?: string;
  data?: any;
  timestamp: Date;
  /**
   * Conversation this update belongs to. A single browser session id can
   * span multiple conversations (e.g. "New chat" started while a previous
   * one is still generating), and both share one SSE stream keyed by
   * sessionId - tagging every update lets the frontend drop updates that
   * belong to a conversation it isn't currently displaying instead of
   * leaking them into whatever conversation happens to be on screen.
   */
  conversationId?: string;
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
  isPipelineExecuting: boolean;
  /** Owner of this session - set on first authenticated interaction */
  userId?: string;
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

  constructor(
    private pipeline: GenerationPipeline,
    private streamTicketService: StreamTicketService,
    private pipelineStatus: PipelineStatusService,
  ) {
    // Start automatic cleanup timer
    this.startCleanupTimer();
  }

  /**
   * Issue a short-lived, single-use ticket that authorizes an SSE connection.
   *
   * Requires authentication (global JWT guard). The returned ticket must be
   * passed to the SSE endpoint as `?ticket=...` within 60 seconds.
   */
  @Post('stream-ticket')
  createStreamTicket(
    @CurrentUser() user: User,
    @Body() dto: CreateStreamTicketDto,
  ): StreamTicketResponseDto {
    const { sessionId } = dto;

    // Bind the session to this user (first caller wins) so a ticket for a
    // session owned by somebody else can never be issued.
    this.ensureSessionExists(sessionId, user.id);
    const session = this.streamSessions.get(sessionId);

    if (session.userId && session.userId !== user.id) {
      this.logger.warn(`Stream ticket denied: session ${sessionId} is owned by another user`);
      throw new NotFoundException(`Session not found: ${sessionId}`);
    }

    const { ticket, expiresInSeconds } = this.streamTicketService.issueTicket(sessionId, user.id);

    this.logger.log(`Issued stream ticket for session: ${sessionId}`);

    return { ticket, expiresInSeconds };
  }

  /**
   * SSE endpoint for streaming conversation updates
   * Supports buffering for late-joining observers
   *
   * Note: @Public() is required because EventSource cannot send Authorization
   * headers. Authorization is enforced here instead via a single-use ticket
   * obtained from POST /api/chat/stream-ticket.
   */
  @Public()
  @SkipThrottle()
  @Sse('stream/:sessionId')
  streamConversation(
    @Param('sessionId') sessionId: string,
    @Query('ticket') ticket?: string,
  ): Observable<MessageEvent> {
    const redeemed = this.streamTicketService.redeemTicket(ticket, sessionId);

    if (!redeemed) {
      this.logger.warn(`SSE connection rejected for session ${sessionId}: invalid ticket`);
      throw new UnauthorizedException('A valid stream ticket is required');
    }

    // Ensure session exists (owned by the ticket holder)
    this.ensureSessionExists(sessionId, redeemed.userId);
    const session = this.streamSessions.get(sessionId);

    if (session.userId && session.userId !== redeemed.userId) {
      this.logger.warn(`SSE connection rejected: session ${sessionId} is owned by another user`);
      throw new UnauthorizedException('A valid stream ticket is required');
    }

    this.logger.log(`SSE connection established for session: ${sessionId}`);

    // Flush buffered updates immediately when observer connects
    if (session.buffer.length > 0) {
      this.logger.log(
        `Flushing ${session.buffer.length} buffered updates for session: ${sessionId}`,
      );

      // Schedule buffer flush after Observable subscription
      setTimeout(() => {
        const currentSession = this.streamSessions.get(sessionId);
        if (currentSession) {
          currentSession.buffer.forEach((buffered) => {
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
        this.logger.log(
          `Session ${sessionId} observer count: ${currentSession.subject.observers.length}`,
        );
      }
    }, 100);

    return session.subject.asObservable().pipe(
      map((update: StreamUpdate) => ({
        data: JSON.stringify(update),
      })),
    );
  }

  /**
   * POST endpoint to send message and trigger pipeline execution
   *
   * Resolves (or creates) the conversation up front so the real conversation
   * UUID can be returned to the caller instead of the placeholder 'new'.
   */
  @Post('message')
  async sendMessage(
    @CurrentUser() user: User,
    @Body() request: SendMessageDto,
  ): Promise<{ success: boolean; conversationId: string }> {
    const { message, sessionId, conversationId } = request;
    this.logger.log(
      `Message received for session: ${sessionId}, conversationId: ${conversationId || 'new'}`,
    );

    // Create session immediately before pipeline execution
    this.ensureSessionExists(sessionId, user.id);

    const session = this.streamSessions.get(sessionId);

    if (session.userId && session.userId !== user.id) {
      this.logger.warn(`Message rejected: session ${sessionId} is owned by another user`);
      throw new NotFoundException(`Session not found: ${sessionId}`);
    }

    // Resolve the conversation now so the caller receives the real UUID.
    // Also enforces conversation ownership for existing conversations.
    const resolvedConversationId = await this.pipeline.ensureConversation(
      sessionId,
      conversationId,
      user.id,
    );

    // Mark the pipeline as executing
    session.isPipelineExecuting = true;
    session.lastActivityAt = new Date();
    this.pipelineStatus.markExecuting(resolvedConversationId);

    // Execute the pipeline in background and stream updates
    this.executeAndStream(sessionId, message, resolvedConversationId, user.id)
      .catch((error) => {
        this.logger.error(`Pipeline execution error for session ${sessionId}: ${error.message}`);
        this.sendStreamUpdate(sessionId, {
          type: 'error',
          message: error.message,
          conversationId: resolvedConversationId,
          timestamp: new Date(),
        });
      })
      .finally(() => {
        const currentSession = this.streamSessions.get(sessionId);
        if (currentSession) {
          currentSession.isPipelineExecuting = false;
          currentSession.lastActivityAt = new Date();
          this.logger.log(`Pipeline execution finished for session: ${sessionId}`);
        }
        this.pipelineStatus.markIdle(resolvedConversationId);
      });

    return {
      success: true,
      conversationId: resolvedConversationId,
    };
  }

  /**
   * Execute the generation pipeline and stream updates with buffering support
   */
  private async executeAndStream(
    sessionId: string,
    userInput: string,
    conversationId?: string,
    userId?: string,
  ): Promise<void> {
    this.logger.log(`Starting pipeline execution for session: ${sessionId}`);

    try {
      const streamGenerator = await this.pipeline.execute(
        sessionId,
        userInput,
        conversationId,
        userId,
      );

      // Process each update from the pipeline
      for await (const update of streamGenerator) {
        this.logger.debug(`Pipeline update received from step: ${update.currentStep}`);

        // Send EVERY new progress entry, not just the most recent one - the
        // previous implementation dropped intermediate messages whenever a step
        // emitted more than one.
        for (const entry of update.streamingUpdates || []) {
          this.sendStreamUpdate(sessionId, {
            type: 'progress',
            node: entry.node,
            message: entry.message,
            conversationId: update.conversationId,
            timestamp: entry.timestamp,
          });
        }

        // Send final result if complete
        if (update.isComplete) {
          this.sendStreamUpdate(sessionId, {
            type: 'complete',
            message: update.response,
            conversationId: update.conversationId,
            data: {
              conversationId: update.conversationId,
              generatedCode: update.generatedCode,
              executionResults: update.executionResults,
            },
            timestamp: new Date(),
          });
        }

        // Send clarification request. Skipped when the `complete` event above
        // already carried the same question as its message - the pipeline sets
        // `response` to the question when it pauses, and emitting both put the
        // question on screen twice.
        if (
          update.needsUserInput &&
          update.clarificationNeeded &&
          update.response !== update.clarificationNeeded.question
        ) {
          this.sendStreamUpdate(sessionId, {
            type: 'result',
            message: update.clarificationNeeded.question,
            conversationId: update.conversationId,
            data: {
              options: update.clarificationNeeded.options,
            },
            timestamp: new Date(),
          });
        }
      }

      this.logger.log(`Pipeline execution completed successfully for session: ${sessionId}`);
    } catch (error) {
      this.logger.error(
        `Pipeline execution failed for session ${sessionId}: ${error.message}`,
        error.stack,
      );
      this.sendStreamUpdate(sessionId, {
        type: 'error',
        message: `Execution failed: ${error.message}`,
        conversationId,
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
    this.logger.debug(
      `Sending ${update.type} update to session ${sessionId} (observers: ${observerCount})`,
    );

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
   *
   * @param userId owner of the session; only applied when the session is created
   */
  private ensureSessionExists(sessionId: string, userId?: string): void {
    if (!this.streamSessions.has(sessionId)) {
      this.logger.log(`Creating new stream session: ${sessionId}`);
      this.streamSessions.set(sessionId, {
        subject: new Subject<StreamUpdate>(),
        buffer: [],
        createdAt: new Date(),
        lastActivityAt: new Date(),
        isPipelineExecuting: false,
        userId,
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

    this.logger.log(
      `Session cleanup timer started (runs every ${this.CLEANUP_INTERVAL_MS / 60000} minutes)`,
    );
  }

  /**
   * Cleanup stale sessions that have been inactive
   * Does NOT cleanup sessions with an active pipeline execution
   */
  private cleanupStaleSessions(): void {
    const now = new Date();
    let cleanedCount = 0;

    for (const [sessionId, session] of this.streamSessions.entries()) {
      const inactiveMs = now.getTime() - session.lastActivityAt.getTime();

      // Don't cleanup sessions with an active pipeline execution
      if (session.isPipelineExecuting) {
        continue;
      }

      // Cleanup sessions inactive for > 30 minutes
      if (inactiveMs > this.SESSION_TIMEOUT_MS) {
        this.logger.log(
          `Cleaning up stale session: ${sessionId} (inactive for ${Math.round(inactiveMs / 60000)}m)`,
        );
        session.subject.complete();
        this.streamSessions.delete(sessionId);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      this.logger.log(
        `Cleaned up ${cleanedCount} stale session(s). Active sessions: ${this.streamSessions.size}`,
      );
    } else {
      this.logger.debug(
        `No stale sessions to cleanup. Active sessions: ${this.streamSessions.size}`,
      );
    }
  }

  /**
   * Cleanup endpoint (optional - for closing streams explicitly)
   */
  @Post('close/:sessionId')
  closeStream(
    @CurrentUser() user: User,
    @Param('sessionId') sessionId: string,
  ): { success: boolean } {
    const session = this.streamSessions.get(sessionId);
    if (session) {
      if (session.userId && session.userId !== user.id) {
        this.logger.warn(`Close denied: session ${sessionId} is owned by another user`);
        throw new NotFoundException(`Session not found: ${sessionId}`);
      }
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
  @SkipThrottle()
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
