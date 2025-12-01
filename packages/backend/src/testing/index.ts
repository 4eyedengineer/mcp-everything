/**
 * Testing Module Exports
 * Provides Docker-based MCP server testing capabilities
 */

export { McpTestingService } from './mcp-testing.service';
export type {
  GeneratedCode,
  ToolTestResult,
  McpServerTestResult,
  TestProgressUpdate,
  McpTestConfig,
} from './mcp-testing.service';

export { TestingModule } from './testing.module';
export { TestingController } from './testing.controller';
export type { TestMcpServerRequest, TestMcpServerResponse } from './testing.controller';

export { TestDrivenRefinementService } from './testing.integration.example';
export {
  FIXTURE_SIMPLE_WORKING_SERVER,
  FIXTURE_BUILD_ERROR_SERVER,
  FIXTURE_INCOMPLETE_SERVER,
  validateFixtures,
} from './testing.fixtures';
