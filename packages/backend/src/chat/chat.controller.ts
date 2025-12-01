import { Controller, Post, Body, Sse, MessageEvent, Param, Get } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';
import { map } from 'rxjs/operators';
import { GraphOrchestrationService } from '../orchestration/graph.service';
import { GraphState } from '../orchestration/types';

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

@Controller('api/chat')
export class ChatController {
  // Map to store streaming subjects per session
  private streamSubjects = new Map<string, Subject<StreamUpdate>>();

  constructor(private graphService: GraphOrchestrationService) {}

  /**
   * SSE endpoint for streaming conversation updates
   */
  @Sse('stream/:sessionId')
  streamConversation(@Param('sessionId') sessionId: string): Observable<MessageEvent> {
    // Create or get subject for this session
    let subject = this.streamSubjects.get(sessionId);
    if (!subject) {
      subject = new Subject<StreamUpdate>();
      this.streamSubjects.set(sessionId, subject);
    }

    // Return observable that transforms updates to SSE format
    return subject.asObservable().pipe(
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

    // Execute graph in background and stream updates
    this.executeAndStream(sessionId, message, conversationId).catch(error => {
      this.sendStreamUpdate(sessionId, {
        type: 'error',
        message: error.message,
        timestamp: new Date(),
      });
    });

    return {
      success: true,
      conversationId: conversationId || 'new',
    };
  }

  /**
   * Execute graph and stream updates
   */
  private async executeAndStream(
    sessionId: string,
    userInput: string,
    conversationId?: string,
  ): Promise<void> {
    try {
      // Get stream generator from graph execution
      const streamGenerator = await this.graphService.executeGraph(
        sessionId,
        userInput,
        conversationId,
      );

      // Process each update from the graph
      for await (const update of streamGenerator) {
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
    } catch (error) {
      this.sendStreamUpdate(sessionId, {
        type: 'error',
        message: `Execution failed: ${error.message}`,
        timestamp: new Date(),
      });
    }
  }

  /**
   * Send update to SSE stream
   */
  private sendStreamUpdate(sessionId: string, update: StreamUpdate): void {
    const subject = this.streamSubjects.get(sessionId);
    if (subject) {
      subject.next(update);
    }
  }

  /**
   * Cleanup endpoint (optional - for closing streams)
   */
  @Post('close/:sessionId')
  closeStream(@Param('sessionId') sessionId: string): { success: boolean } {
    const subject = this.streamSubjects.get(sessionId);
    if (subject) {
      subject.complete();
      this.streamSubjects.delete(sessionId);
    }
    return { success: true };
  }

  /**
   * Health check
   */
  @Get('health')
  health(): { status: string; timestamp: Date } {
    return {
      status: 'ok',
      timestamp: new Date(),
    };
  }
}
