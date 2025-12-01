import { Module } from '@nestjs/common';
import { McpTestingService } from './mcp-testing.service';
import { TestingController } from './testing.controller';

/**
 * Testing Module
 * Provides Docker-based MCP server testing capabilities
 */
@Module({
  providers: [McpTestingService],
  controllers: [TestingController],
  exports: [McpTestingService],
})
export class TestingModule {}
