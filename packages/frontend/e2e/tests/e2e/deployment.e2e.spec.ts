import { test, expect } from '@playwright/test';
import { ChatE2EPage } from '../../page-objects/chat-e2e.page';
import { KindClusterFixture } from '../../fixtures/kind-cluster';
import { E2EBackendFixture } from '../../fixtures/e2e-backend';

/**
 * KinD Deployment Flow E2E Tests
 *
 * These tests validate the complete deployment flow from generated MCP server
 * to running container in KinD cluster.
 *
 * Flow: generate → deploy → access
 * 1. Docker image is built from generated code
 * 2. Image is pushed to local registry (localhost:5000)
 * 3. K8s manifests are generated (Deployment, Service, Ingress)
 * 4. Manifests are applied to KinD cluster
 * 5. Server becomes accessible at `{serverId}.mcp.localhost`
 *
 * Prerequisites:
 * - KinD cluster running (./scripts/kind/setup.sh)
 * - Backend and frontend running
 * - Claude API key configured
 */
test.describe('KinD Deployment Flow', () => {
  // Configure extended timeouts for generation and deployment
  test.describe.configure({
    mode: 'serial', // Run tests serially to avoid resource conflicts
    timeout: 600000, // 10 min max per test
  });

  let chatPage: ChatE2EPage;
  let kindCluster: KindClusterFixture;
  let backend: E2EBackendFixture;
  let deployedServerId: string | null = null;

  test.beforeEach(async ({ page }) => {
    chatPage = new ChatE2EPage(page);
    kindCluster = new KindClusterFixture();
    backend = new E2EBackendFixture();
    await chatPage.navigate();
  });

  test.afterEach(async () => {
    // Cleanup deployed server
    if (deployedServerId) {
      try {
        await kindCluster.cleanupTestServer(deployedServerId);
        console.log(`Cleaned up test server: ${deployedServerId}`);
      } catch (e) {
        console.log(`Cleanup failed for ${deployedServerId}: ${(e as Error).message}`);
      }
      deployedServerId = null;
    }
  });

  test('full deployment flow: generate -> deploy -> access', async ({ page }) => {
    // Step 1: Generate MCP server
    await chatPage.sendMessage('Create a simple MCP server with a "hello" tool that returns a greeting');
    await chatPage.waitForGenerationComplete(300000);

    expect(await chatPage.didGenerationSucceed()).toBe(true);

    // Step 2: Click deploy button
    await chatPage.waitForDeployButton(30000);
    await chatPage.clickDeployButton();

    // Step 3: Wait for deployment to complete
    const conversationId = chatPage.getConversationIdFromUrl();
    expect(conversationId).toBeTruthy();

    // Deploy via backend API
    const deployResult = await backend.deployToKinD(conversationId!);
    expect(deployResult.success).toBe(true);
    expect(deployResult.serverId).toBeTruthy();

    deployedServerId = deployResult.serverId;

    // Wait for deployment status to be running
    const deployStatus = await backend.waitForDeploymentStatus(
      deployedServerId,
      'running',
      120000 // 2 min timeout
    );

    expect(deployStatus.status).toBe('running');

    // Step 4: Verify K8s resources
    const resources = await kindCluster.getServerResources(deployedServerId);
    expect(resources.deployment.metadata?.name).toBe(deployedServerId);
    expect(resources.service.metadata?.name).toBe(deployedServerId);
    expect(resources.ingress.metadata?.name).toBe(deployedServerId);

    // Step 5: Test endpoint
    await kindCluster.waitForDeployment(deployedServerId, 60000);
    const endpointResult = await kindCluster.testServerEndpoint(deployedServerId, '/health');
    expect(endpointResult.status).toBe(200);
  });

  test('K8s Deployment resource is created correctly', async ({ page }) => {
    await chatPage.sendMessage('Create MCP server with a ping tool');
    await chatPage.waitForGenerationComplete(300000);
    await chatPage.clickDeployButton();

    const conversationId = chatPage.getConversationIdFromUrl()!;
    const deployResult = await backend.deployToKinD(conversationId);
    deployedServerId = deployResult.serverId;

    await backend.waitForDeploymentStatus(deployedServerId, 'running', 120000);

    const resources = await kindCluster.getServerResources(deployedServerId);
    const deployment = resources.deployment;

    // Validate deployment spec
    expect(deployment.metadata?.namespace).toBe('mcp-servers');
    expect(deployment.spec?.replicas).toBe(1);
    expect(deployment.spec?.template?.spec?.containers?.[0]?.image).toContain('localhost:5000');
    expect(deployment.spec?.template?.spec?.containers?.[0]?.ports?.[0]?.containerPort).toBe(3000);
  });

  test('K8s Service resource is created correctly', async ({ page }) => {
    await chatPage.sendMessage('Create MCP server with an echo tool');
    await chatPage.waitForGenerationComplete(300000);
    await chatPage.clickDeployButton();

    const conversationId = chatPage.getConversationIdFromUrl()!;
    const deployResult = await backend.deployToKinD(conversationId);
    deployedServerId = deployResult.serverId;

    await backend.waitForDeploymentStatus(deployedServerId, 'running', 120000);

    const resources = await kindCluster.getServerResources(deployedServerId);
    const service = resources.service;

    expect(service.metadata?.namespace).toBe('mcp-servers');
    expect(service.spec?.type).toBe('ClusterIP');
    expect(service.spec?.ports?.[0]?.port).toBe(80);
    expect(service.spec?.ports?.[0]?.targetPort).toBe(3000);
  });

  test('K8s Ingress routes to server correctly', async ({ page }) => {
    await chatPage.sendMessage('Create MCP server with a test tool');
    await chatPage.waitForGenerationComplete(300000);
    await chatPage.clickDeployButton();

    const conversationId = chatPage.getConversationIdFromUrl()!;
    const deployResult = await backend.deployToKinD(conversationId);
    deployedServerId = deployResult.serverId;

    await backend.waitForDeploymentStatus(deployedServerId, 'running', 120000);

    const resources = await kindCluster.getServerResources(deployedServerId);
    const ingress = resources.ingress;

    expect(ingress.metadata?.namespace).toBe('mcp-servers');
    expect(ingress.spec?.rules?.[0]?.host).toBe(`${deployedServerId}.mcp.localhost`);

    // Test actual routing
    await kindCluster.waitForDeployment(deployedServerId, 60000);
    const result = await kindCluster.testServerEndpoint(deployedServerId, '/');
    expect(result.status).toBe(200);
  });

  test('health endpoint returns correct response', async ({ page }) => {
    await chatPage.sendMessage('Create MCP server for testing');
    await chatPage.waitForGenerationComplete(300000);
    await chatPage.clickDeployButton();

    const conversationId = chatPage.getConversationIdFromUrl()!;
    const deployResult = await backend.deployToKinD(conversationId);
    deployedServerId = deployResult.serverId;

    await backend.waitForDeploymentStatus(deployedServerId, 'running', 120000);

    // Wait for pod to be ready
    await kindCluster.waitForDeployment(deployedServerId, 60000);

    const result = await kindCluster.testServerEndpoint(deployedServerId, '/health');
    expect(result.status).toBe(200);
    expect(result.body).toHaveProperty('status');
    expect(result.body.status).toMatch(/healthy|ok/i);
  });

  test('deployment handles build failure gracefully', async () => {
    // This would require a way to trigger build failure
    // Could use a special input that generates invalid code
    // Or mock the build service to fail
    test.skip(true, 'Requires build failure injection');
  });

  test('pod logs are accessible after deployment', async ({ page }) => {
    await chatPage.sendMessage('Create MCP server with logging');
    await chatPage.waitForGenerationComplete(300000);
    await chatPage.clickDeployButton();

    const conversationId = chatPage.getConversationIdFromUrl()!;
    const deployResult = await backend.deployToKinD(conversationId);
    deployedServerId = deployResult.serverId;

    await backend.waitForDeploymentStatus(deployedServerId, 'running', 120000);

    // Wait for pod to start
    await kindCluster.waitForDeployment(deployedServerId, 60000);

    // Get logs
    const logs = await kindCluster.getPodLogs(deployedServerId, 50);

    // Should have some startup logs
    expect(logs.length).toBeGreaterThan(0);
    expect(logs).toMatch(/start|listen|running/i);
  });

  test('server can be stopped and started', async ({ page }) => {
    await chatPage.sendMessage('Create MCP server for start/stop test');
    await chatPage.waitForGenerationComplete(300000);
    await chatPage.clickDeployButton();

    const conversationId = chatPage.getConversationIdFromUrl()!;
    const deployResult = await backend.deployToKinD(conversationId);
    deployedServerId = deployResult.serverId;

    await backend.waitForDeploymentStatus(deployedServerId, 'running', 120000);

    // Verify running
    await kindCluster.waitForDeployment(deployedServerId, 60000);
    let result = await kindCluster.testServerEndpoint(deployedServerId, '/health');
    expect(result.status).toBe(200);

    // Stop server (scale to 0)
    await backend.stopServer(deployedServerId);

    // Wait for scale down
    await page.waitForTimeout(10000);

    // Should not be accessible (connection refused or timeout)
    result = await kindCluster.testServerEndpoint(deployedServerId, '/health');
    expect(result.status).not.toBe(200);

    // Start server (scale to 1)
    await backend.startServer(deployedServerId);

    // Wait for scale up
    await kindCluster.waitForDeployment(deployedServerId, 60000);

    // Should be accessible again
    result = await kindCluster.testServerEndpoint(deployedServerId, '/health');
    expect(result.status).toBe(200);
  });

  test('server can be deleted', async ({ page }) => {
    await chatPage.sendMessage('Create MCP server for deletion test');
    await chatPage.waitForGenerationComplete(300000);
    await chatPage.clickDeployButton();

    const conversationId = chatPage.getConversationIdFromUrl()!;
    const deployResult = await backend.deployToKinD(conversationId);
    const serverId = deployResult.serverId;

    await backend.waitForDeploymentStatus(serverId, 'running', 120000);

    // Delete server
    await backend.deleteServer(serverId);

    // Wait for deletion
    await page.waitForTimeout(10000);

    // Resources should be gone
    const resources = await kindCluster.getServerResources(serverId);
    expect(resources.deployment.metadata?.name).toBeFalsy();
    expect(resources.service.metadata?.name).toBeFalsy();
    expect(resources.ingress.metadata?.name).toBeFalsy();

    // Clear deployedServerId since already deleted
    deployedServerId = null;
  });
});
