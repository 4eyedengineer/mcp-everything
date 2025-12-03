import { test, expect } from '@playwright/test';
import { ChatE2EPage } from '../../page-objects/chat-e2e.page';

const TEST_SERVICES = {
  // Well-known APIs
  stripe: 'Stripe payment processing API',
  openai: 'OpenAI GPT API',
  github: 'GitHub repository management API',

  // Specific tool requests
  stripeTools:
    'Create MCP server for Stripe with tools for creating charges and managing customers',

  // Ambiguous
  ambiguous: 'Create an MCP server for payments',

  // Unknown
  unknown: 'Create MCP for XyzNonExistentService123',
};

test.describe('Service Name Generation Flow', () => {
  let chatPage: ChatE2EPage;

  test.beforeEach(async ({ page }) => {
    chatPage = new ChatE2EPage(page);
    await chatPage.navigate();
  });

  test('generates MCP server for Stripe API', async () => {
    const result = await chatPage.sendAndWaitForGeneration(
      `Create MCP server for ${TEST_SERVICES.stripe}`,
      300000,
    );

    // Should complete (either with code or asking for clarification)
    expect(result.finalResponse.length).toBeGreaterThan(0);

    // Response should mention Stripe
    expect(result.finalResponse.toLowerCase()).toContain('stripe');
  });

  test('generates MCP server for OpenAI API', async () => {
    await chatPage.sendMessage(
      `Build an MCP server for ${TEST_SERVICES.openai}`,
    );

    // Wait for some response
    await chatPage.waitForGenerationComplete(300000);

    const response = await chatPage.getLastAssistantMessage();
    expect(response.toLowerCase()).toMatch(/openai|gpt|chat|completion/);
  });

  test('generates MCP server for GitHub API', async () => {
    await chatPage.sendMessage(`Create MCP for ${TEST_SERVICES.github}`);

    await chatPage.waitForGenerationComplete(300000);

    const response = await chatPage.getLastAssistantMessage();
    expect(response.toLowerCase()).toMatch(
      /github|repository|repo|pull request/,
    );
  });

  test('handles specific tool requirements', async () => {
    await chatPage.sendMessage(TEST_SERVICES.stripeTools);

    await chatPage.waitForGenerationComplete(300000);

    const response = await chatPage.getLastAssistantMessage();
    // Should acknowledge the specific tools requested
    expect(response.toLowerCase()).toMatch(/charge|customer|payment/);
  });

  test('asks for clarification on ambiguous requests', async () => {
    await chatPage.sendMessage(TEST_SERVICES.ambiguous);

    // Wait for response (should be quick since it needs clarification)
    await chatPage.waitForAssistantResponse(60000);

    const response = await chatPage.getLastAssistantMessage();

    // Should ask for more details or suggest options
    expect(response.toLowerCase()).toMatch(
      /which|what|clarify|specify|stripe|paypal|square/,
    );
  });

  test('handles unknown services gracefully', async () => {
    await chatPage.sendMessage(TEST_SERVICES.unknown);

    await chatPage.waitForAssistantResponse(60000);

    const response = await chatPage.getLastAssistantMessage();

    // Should respond (not crash), possibly asking for clarification
    expect(response.length).toBeGreaterThan(0);

    // Should not show download (no valid generation)
    // Or should ask for more information
  });

  test('research phase occurs for service names', async () => {
    await chatPage.sendMessage(`Create MCP for ${TEST_SERVICES.stripe}`);

    // Track progress
    const progressMessages = await chatPage.trackProgressMessages(120000);

    // Should include research phase
    const hasResearch = progressMessages.some(
      (m) =>
        m.toLowerCase().includes('research') ||
        m.toLowerCase().includes('analyzing'),
    );
    expect(hasResearch).toBe(true);
  });

  test('multi-turn refinement for service name', async () => {
    // Start with vague request
    await chatPage.sendMessage('I want an MCP server for payment processing');
    await chatPage.waitForAssistantResponse(60000);

    // Provide clarification
    await chatPage.sendMessage('Use Stripe and include tools for subscriptions');
    await chatPage.waitForGenerationComplete(300000);

    const response = await chatPage.getLastAssistantMessage();
    expect(response.toLowerCase()).toMatch(/stripe|subscription/);
  });
});
