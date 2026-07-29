import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { randomBytes } from 'crypto';

/**
 * A short lived, single-use ticket that authorizes an SSE stream connection.
 *
 * EventSource cannot send an Authorization header, so the SSE route itself has
 * to stay @Public() at the guard level. Instead of relying on the (client
 * chosen) sessionId being unguessable, the client first calls the
 * authenticated `POST /api/chat/stream-ticket` endpoint and then redeems the
 * returned ticket on the SSE URL: `GET /api/chat/stream/:sessionId?ticket=...`
 */
export interface StreamTicket {
  sessionId: string;
  userId: string;
  expiresAt: number;
}

@Injectable()
export class StreamTicketService implements OnModuleDestroy {
  private readonly logger = new Logger(StreamTicketService.name);

  /** ticket -> ticket metadata */
  private readonly tickets = new Map<string, StreamTicket>();

  /** Tickets are valid for 60 seconds and can only be redeemed once */
  public static readonly TTL_SECONDS = 60;
  private static readonly CLEANUP_INTERVAL_MS = 30 * 1000;

  private readonly cleanupTimer: NodeJS.Timeout;

  constructor() {
    this.cleanupTimer = setInterval(
      () => this.cleanupExpiredTickets(),
      StreamTicketService.CLEANUP_INTERVAL_MS,
    );
    // Do not keep the event loop alive just for ticket cleanup
    this.cleanupTimer.unref?.();
  }

  /**
   * Issue a new single-use ticket for (sessionId, userId).
   *
   * @returns the opaque ticket string
   */
  issueTicket(sessionId: string, userId: string): { ticket: string; expiresInSeconds: number } {
    const ticket = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + StreamTicketService.TTL_SECONDS * 1000;

    this.tickets.set(ticket, { sessionId, userId, expiresAt });

    this.logger.debug(
      `Issued stream ticket for session ${sessionId} (user ${userId}), expires in ${StreamTicketService.TTL_SECONDS}s`,
    );

    return { ticket, expiresInSeconds: StreamTicketService.TTL_SECONDS };
  }

  /**
   * Redeem a ticket. The ticket must exist, be unexpired and match the
   * requested sessionId. Redemption consumes the ticket (single use).
   *
   * @returns the ticket metadata on success, or null when invalid
   */
  redeemTicket(ticket: string | undefined, sessionId: string): StreamTicket | null {
    if (!ticket) {
      return null;
    }

    const entry = this.tickets.get(ticket);
    if (!entry) {
      this.logger.warn(`Stream ticket rejected: unknown ticket for session ${sessionId}`);
      return null;
    }

    // Single use: consume regardless of the outcome below
    this.tickets.delete(ticket);

    if (entry.expiresAt <= Date.now()) {
      this.logger.warn(`Stream ticket rejected: expired ticket for session ${sessionId}`);
      return null;
    }

    if (entry.sessionId !== sessionId) {
      this.logger.warn(
        `Stream ticket rejected: session mismatch (ticket=${entry.sessionId}, requested=${sessionId})`,
      );
      return null;
    }

    return entry;
  }

  /**
   * Remove expired tickets so the map cannot grow without bound.
   */
  private cleanupExpiredTickets(): void {
    const now = Date.now();
    let removed = 0;

    for (const [ticket, entry] of this.tickets.entries()) {
      if (entry.expiresAt <= now) {
        this.tickets.delete(ticket);
        removed++;
      }
    }

    if (removed > 0) {
      this.logger.debug(`Cleaned up ${removed} expired stream ticket(s)`);
    }
  }

  /** Number of outstanding (possibly expired) tickets - used by tests/diagnostics */
  get pendingTicketCount(): number {
    return this.tickets.size;
  }

  onModuleDestroy(): void {
    clearInterval(this.cleanupTimer);
    this.tickets.clear();
  }
}
