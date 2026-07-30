import { Controller, Get, Post, Delete, Body, Param, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiKeyService } from './api-key.service';
import { CreateApiKeyDto } from './dto/create-api-key.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../database/entities/user.entity';

// Protected by the global JwtAuthGuard (JWT or API key) - all routes here are
// implicitly scoped to the current user via @CurrentUser().
@Controller('api/v1/api-keys')
export class ApiKeyController {
  constructor(private readonly apiKeyService: ApiKeyService) {}

  /**
   * Create a new API key. The full plaintext key is returned exactly once -
   * it is not recoverable afterwards since only its hash is persisted.
   */
  @Post()
  async create(@CurrentUser() user: User, @Body() dto: CreateApiKeyDto) {
    const created = await this.apiKeyService.createKey(user.id, dto.name);
    return {
      apiKey: {
        id: created.id,
        name: created.name,
        key: created.key,
        keyPrefix: created.keyPrefix,
        createdAt: created.createdAt,
      },
    };
  }

  /** List the current user's API keys (never includes the plaintext key). */
  @Get()
  async list(@CurrentUser() user: User) {
    const keys = await this.apiKeyService.listKeys(user.id);
    return { apiKeys: keys };
  }

  /** Revoke an API key owned by the current user. */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async revoke(@CurrentUser() user: User, @Param('id') id: string) {
    await this.apiKeyService.revokeKey(user.id, id);
    return { success: true };
  }
}
