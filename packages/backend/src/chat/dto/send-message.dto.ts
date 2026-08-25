import { IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * Request body for POST /api/chat/message
 */
export class SendMessageDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(20000)
  message: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  sessionId: string;

  /** Existing conversation to continue; omitted for a brand new conversation */
  @IsOptional()
  @IsUUID()
  conversationId?: string;
}
