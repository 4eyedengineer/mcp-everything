import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * Request body for POST /api/chat/stream-ticket
 */
export class CreateStreamTicketDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  sessionId: string;
}

/**
 * Response body for POST /api/chat/stream-ticket
 */
export class StreamTicketResponseDto {
  /** Opaque single-use ticket to be passed as ?ticket= on the SSE URL */
  ticket: string;

  /** Ticket lifetime in seconds */
  expiresInSeconds: number;
}
