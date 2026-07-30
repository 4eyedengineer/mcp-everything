import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Conversation } from '../database/entities';
import { ChatModule } from '../chat/chat.module';
import { MarketplaceModule } from '../marketplace/marketplace.module';
import { McpServerController } from './mcp-server.controller';
import { McpToolsService } from './mcp-tools.service';

/**
 * Exposes MCP Everything itself as an MCP server (POST/GET/DELETE /mcp,
 * Streamable HTTP transport, 2026-07-28 spec, stateless per request).
 *
 * Deliberately has no generation/marketplace logic of its own: it imports
 * `ChatModule` for the already-exported `GenerationPipeline` and
 * `MarketplaceModule` for `MarketplaceService`, and only adds its own
 * `TypeOrmModule.forFeature([Conversation])` for the read-scoped lookups
 * (`list_conversations`, `get_generation_status`, `get_generated_server`, and
 * the sessionId lookup `continue_generation` needs) that don't warrant
 * depending on `ConversationService` (a ChatModule-internal provider that
 * isn't exported).
 */
@Module({
  imports: [TypeOrmModule.forFeature([Conversation]), ChatModule, MarketplaceModule],
  controllers: [McpServerController],
  providers: [McpToolsService],
})
export class McpServerModule {}
