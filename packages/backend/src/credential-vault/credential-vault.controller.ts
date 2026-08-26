import { Controller, Get, Post, Delete, Body, Param, HttpCode, HttpStatus } from '@nestjs/common';
import { CredentialVaultService } from './credential-vault.service';
import { CreateCredentialDto } from './dto/create-credential.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../database/entities/user.entity';

// Protected by the global JwtAuthGuard - all routes here are implicitly
// scoped to the current user via @CurrentUser().
@Controller('api/v1/credentials')
export class CredentialVaultController {
  constructor(private readonly credentialVaultService: CredentialVaultService) {}

  /**
   * Store a new credential, encrypted at rest. The plaintext value supplied
   * here is never echoed back - not in this response, nor by any other
   * endpoint on this controller.
   */
  @Post()
  async create(@CurrentUser() user: User, @Body() dto: CreateCredentialDto) {
    const created = await this.credentialVaultService.createCredential(user.id, {
      name: dto.name,
      value: dto.value,
      description: dto.description,
    });

    return {
      credential: created,
      warning:
        'This value is stored encrypted and cannot be retrieved again. ' +
        'To change it, delete this credential and create a new one.',
    };
  }

  /** List metadata for the current user's credentials (never includes the value). */
  @Get()
  async list(@CurrentUser() user: User) {
    const credentials = await this.credentialVaultService.listCredentials(user.id);
    return { credentials };
  }

  /** Delete a credential owned by the current user. */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async remove(@CurrentUser() user: User, @Param('id') id: string) {
    await this.credentialVaultService.deleteCredential(user.id, id);
    return { success: true };
  }
}
