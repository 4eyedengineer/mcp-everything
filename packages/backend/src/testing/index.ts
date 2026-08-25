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
  SandboxMode,
} from './mcp-testing.service';

export { K8sTestSandboxService } from './k8s-test-sandbox.service';
export type {
  TestSandboxHandle,
  CreateSandboxInput,
  SandboxReadiness,
} from './k8s-test-sandbox.service';

export { TestingModule } from './testing.module';
export { TestingController } from './testing.controller';
export type { TestMcpServerRequest, TestMcpServerResponse } from './testing.controller';

export {
  FIXTURE_SIMPLE_WORKING_SERVER,
  FIXTURE_BUILD_ERROR_SERVER,
  FIXTURE_INCOMPLETE_SERVER,
  validateFixtures,
} from './testing.fixtures';
