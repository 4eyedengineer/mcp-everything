import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Conversation } from '../database/entities';
import { ChatModule } from '../chat/chat.module';
import { MarketplaceModule } from '../marketplace/marketplace.module';
import { HostingModule } from '../hosting/hosting.module';
import { McpServerController } from './mcp-server.controller';
import { McpToolsService } from './mcp-tools.service';

/**
 * Exposes MCP Everything itself as an MCP server (POST/GET/DELETE /mcp,
 * Streamable HTTP transport, 2026-07-28 spec, stateless per request).
 *
 * Deliberately has no generation/marketplace logic of its own: it imports
 * `ChatModule` for the already-exported `GenerationPipeline`,
 * `MarketplaceModule` for `MarketplaceService`, and `HostingModule` for the
 * exported `HostingService` + `HostedMcpClientService` that back the
 * cross-server `search_tools`/`call_tool` aggregators, and only adds its own
 * `TypeOrmModule.forFeature([Conversation])` for the read-scoped lookups
 * (`list_conversations`, `get_generation_status`, `get_generated_server`, and
 * the sessionId lookup `continue_generation` needs) that don't warrant
 * depending on `ConversationService` (a ChatModule-internal provider that
 * isn't exported).
 */
@Module({
  imports: [TypeOrmModule.forFeature([Conversation]), ChatModule, MarketplaceModule, HostingModule],
  controllers: [McpServerController],
  providers: [McpToolsService],
})
export class McpServerModule {}
