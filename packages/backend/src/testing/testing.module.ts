import { Module } from '@nestjs/common';
import { McpTestingService } from './mcp-testing.service';
import { K8sTestSandboxService } from './k8s-test-sandbox.service';
import { TestingController } from './testing.controller';

/**
 * Testing Module
 * Provides MCP server testing capabilities.
 *
 * Two sandbox backends live here:
 *  - Docker (default local path), used directly by McpTestingService.
 *  - K8sTestSandboxService, the in-cluster test-pod sandbox for when the
 *    backend has no Docker daemon. It is provided in THIS module rather than
 *    imported from HostingModule so McpTestingService can depend on it with no
 *    module-import cycle (it depends only on the global ConfigService, and
 *    builds its own @kubernetes/client-node clients the same way
 *    K8sControlPlaneService does).
 */
@Module({
  providers: [McpTestingService, K8sTestSandboxService],
  controllers: [TestingController],
  exports: [McpTestingService, K8sTestSandboxService],
})
export class TestingModule {}
