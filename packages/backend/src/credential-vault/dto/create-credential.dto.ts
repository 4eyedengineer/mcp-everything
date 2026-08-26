import { IsString, IsOptional, MinLength, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateCredentialDto {
  @ApiProperty({
    example: 'GITHUB_TOKEN',
    description: 'User-facing handle for this credential, used to reference it from a deployment',
  })
  @IsString()
  @MinLength(1, { message: 'Name is required' })
  @MaxLength(100, { message: 'Name must not exceed 100 characters' })
  name: string;

  /**
   * The plaintext secret. Accepted here and encrypted immediately by
   * `CredentialVaultService` - never persisted in plaintext, never echoed
   * back in any response, never logged.
   */
  @ApiProperty({
    example: 'ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    description: 'The secret value to store, encrypted at rest. Cannot be retrieved again.',
  })
  @IsString()
  @MinLength(1, { message: 'Value is required' })
  @MaxLength(8000, { message: 'Value must not exceed 8000 characters' })
  value: string;

  @ApiPropertyOptional({ example: 'Personal access token used for repo research' })
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'Description must not exceed 500 characters' })
  description?: string;
}
