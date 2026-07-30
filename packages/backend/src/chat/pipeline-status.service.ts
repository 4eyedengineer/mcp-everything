import { Injectable } from '@nestjs/common';

/**
 * Tracks, per conversation, whether a pipeline run is currently executing on
 * this server process.
 *
 * This is intentionally in-memory and process-local rather than a persisted
 * column: a pipeline run is an in-process async generator, so if this process
 * restarts there is no run left to report as "in progress" for any
 * conversation - reporting everything as idle after a restart is the correct
 * answer, not a gap. Paused runs awaiting a clarification reply are a
 * different, durable state and are already tracked on the Conversation row
 * itself (`state.pipeline.awaitingClarification`); this service only covers
 * the "actively streaming right now" signal the frontend needs to decide
 * whether to show a processing/resume UI when a user (re)opens a
 * conversation.
 */
@Injectable()
export class PipelineStatusService {
  private readonly executing = new Set<string>();

  markExecuting(conversationId: string): void {
    this.executing.add(conversationId);
  }

  markIdle(conversationId: string): void {
    this.executing.delete(conversationId);
  }

  isExecuting(conversationId: string): boolean {
    return this.executing.has(conversationId);
  }
}
