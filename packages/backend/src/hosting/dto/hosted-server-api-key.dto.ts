import { IsString, IsOptional, IsInt, Min, Max, MinLength, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateHostedServerApiKeyDto {
  @ApiProperty({
    example: 'ci-runner',
    description: 'Label so you can tell your keys apart later',
  })
  @IsString()
  @MinLength(1, { message: 'A label is required' })
  @MaxLength(100, { message: 'Label must not exceed 100 characters' })
  label: string;

  @ApiPropertyOptional({
    example: 90,
    description: 'Optional lifetime in days. Omit for a key that never expires.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3650)
  expiresInDays?: number;
}

/** Key metadata. Contains no secret material and is safe to return repeatedly. */
export class HostedServerApiKeyResponseDto {
  id: string;
  label: string;
  /** Non-secret leading chars, e.g. `mcps_A1b2c3`. */
  keyPrefix: string;
  /** Last 4 chars of the key, for disambiguation in a list. */
  lastFour: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  active: boolean;
}

/**
 * Response body for key creation - the ONLY response that ever carries `key`.
 *
 * `key` is the full plaintext credential. It is not stored (only its SHA-256
 * hash is) and there is no endpoint that can return it again: if it is lost,
 * the only remedy is to revoke this key and create a new one.
 */
export class CreatedHostedServerApiKeyResponseDto {
  /** Plaintext key. Shown once. Unrecoverable afterwards. */
  key: string;

  /** Metadata for the key just created. */
  apiKey: HostedServerApiKeyResponseDto;

  /**
   * Machine-readable statement of the two things a caller must understand:
   * the secret is shown once, and how to actually use it.
   *
   * `notYetEnforced` was removed rather than reworded when the MCP gateway
   * landed - it said "nothing verifies it on incoming requests today", which
   * stopped being true the moment `HostedServerGatewayGuard` started calling
   * `verifyKey()`. A field whose name asserts a security property must not
   * outlive that property.
   */
  warning: {
    shownOnce: string;
    usage: string;
  };
}
