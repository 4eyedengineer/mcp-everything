import { test, expect } from '@playwright/test';
import { ChatE2EPage } from '../../page-objects/chat-e2e.page';

/**
 * E2E Test Suite: Clarification Flow Tests
 *
 * These tests validate the multi-turn clarification flow when the AI needs
 * more information from the user.
 *
 * Flow:
 * 1. User sends ambiguous/incomplete request
 * 2. Backend detects gaps in understanding via AI
 * 3. LangGraph transitions to clarifyWithUser node
 * 4. AI formulates clarifying questions (max 2 per round)
 * 5. User provides clarification
 * 6. System resumes generation with additional context
 *
 * Requirements:
 * - Real backend running (no mocks)
 * - Claude API key configured
 * - Clarification responses typically faster than full generation
 */

// Timeouts for clarification vs full generation
const TIMEOUTS = {
  clarification: 60000, // 60s for clarification response
  generation: 300000, // 5 min for full generation
};

test.describe('Clarification Flow', () => {
  let chatPage: ChatE2EPage;

  test.beforeEach(async ({ page }) => {
    chatPage = new ChatE2EPage(page);
    await chatPage.navigate();
  });

  test(
    'asks clarification for ambiguous request and proceeds after answer',
    async () => {
      // Send ambiguous request
      await chatPage.sendMessage('Create an MCP server for me');

      // Wait for clarification question
      await chatPage.waitForAssistantResponse(TIMEOUTS.clarification);

      const firstResponse = await chatPage.getLastAssistantMessage();
      expect(firstResponse.toLowerCase()).toMatch(
        /what|which|specify|type|kind|more/
      );

      // Provide clarification
      await chatPage.sendMessage(
        'I want to interact with the GitHub API to manage repositories'
      );

      // Should now proceed with generation
      await chatPage.waitForGenerationComplete(TIMEOUTS.generation);

      const finalResponse = await chatPage.getLastAssistantMessage();
      expect(finalResponse.toLowerCase()).toMatch(/github|repository/);
    },
    { timeout: TIMEOUTS.generation + TIMEOUTS.clarification + 30000 }
  );

  test(
    'handles multi-round clarification',
    async () => {
      // Round 1: Very vague
      await chatPage.sendMessage('Build me something for data');
      await chatPage.waitForAssistantResponse(TIMEOUTS.clarification);

      // Round 2: Slightly more specific
      await chatPage.sendMessage('Database operations');
      await chatPage.waitForAssistantResponse(TIMEOUTS.clarification);

      // Round 3: Specific
      await chatPage.sendMessage(
        'PostgreSQL - I want to run queries and manage tables'
      );
      await chatPage.waitForGenerationComplete(TIMEOUTS.generation);

      const response = await chatPage.getLastAssistantMessage();
      expect(response.toLowerCase()).toMatch(/postgres|sql|database|query/);
    },
    { timeout: TIMEOUTS.generation + TIMEOUTS.clarification * 3 + 30000 }
  );

  test(
    'allows user to change direction mid-clarification',
    async () => {
      // Start with one service
      await chatPage.sendMessage('Create an MCP server for payments');
      await chatPage.waitForAssistantResponse(TIMEOUTS.clarification);

      // Change direction
      await chatPage.sendMessage(
        'Actually, forget payments. I want to work with email instead.'
      );
      await chatPage.waitForAssistantResponse(TIMEOUTS.clarification);

      // Continue with new direction
      await chatPage.sendMessage('Gmail API - send and read emails');
      await chatPage.waitForGenerationComplete(TIMEOUTS.generation);

      const response = await chatPage.getLastAssistantMessage();
      expect(response.toLowerCase()).toMatch(/email|gmail|send|read/);
      expect(response.toLowerCase()).not.toMatch(/payment|stripe|charge/);
    },
    { timeout: TIMEOUTS.generation + TIMEOUTS.clarification * 3 + 30000 }
  );

  test(
    'maintains context across clarification rounds',
    async () => {
      // Establish context
      await chatPage.sendMessage(
        'I need an MCP server for my e-commerce website'
      );
      await chatPage.waitForAssistantResponse(TIMEOUTS.clarification);

      // Add detail without repeating context
      await chatPage.sendMessage('Focus on inventory management');
      await chatPage.waitForAssistantResponse(TIMEOUTS.clarification);

      // Add more detail
      await chatPage.sendMessage(
        'Track stock levels, get low stock alerts, update quantities'
      );
      await chatPage.waitForGenerationComplete(TIMEOUTS.generation);

      const response = await chatPage.getLastAssistantMessage();
      expect(response.toLowerCase()).toMatch(/inventory|stock/);
    },
    { timeout: TIMEOUTS.generation + TIMEOUTS.clarification * 3 + 30000 }
  );

  test(
    'handles "I dont know" responses',
    async () => {
      await chatPage.sendMessage('Create an MCP server');
      await chatPage.waitForAssistantResponse(TIMEOUTS.clarification);

      // User doesn't know what they want
      await chatPage.sendMessage("I'm not sure, what are my options?");
      await chatPage.waitForAssistantResponse(TIMEOUTS.clarification);

      const response = await chatPage.getLastAssistantMessage();
      // Should provide suggestions or examples
      expect(response.length).toBeGreaterThan(50); // Substantive response
    },
    { timeout: TIMEOUTS.clarification * 2 + 30000 }
  );

  test(
    'handles terse responses',
    async () => {
      await chatPage.sendMessage('MCP server for API');
      await chatPage.waitForAssistantResponse(TIMEOUTS.clarification);

      // Terse response
      await chatPage.sendMessage('REST');
      await chatPage.waitForAssistantResponse(TIMEOUTS.clarification);

      // Should ask for more or make reasonable assumptions
      const response = await chatPage.getLastAssistantMessage();
      expect(response.length).toBeGreaterThan(0);
    },
    { timeout: TIMEOUTS.clarification * 2 + 30000 }
  );

  test(
    'preserves conversation history in URL',
    async () => {
      await chatPage.sendMessage('Create MCP for file operations');
      await chatPage.waitForAssistantResponse(TIMEOUTS.clarification);

      // Check URL has conversation ID
      const conversationId = chatPage.getConversationIdFromUrl();
      expect(conversationId).toBeTruthy();

      // Add clarification
      await chatPage.sendMessage('Local filesystem - read, write, list files');
      await chatPage.waitForAssistantResponse(TIMEOUTS.clarification);

      // URL should have same conversation ID
      const sameConversationId = chatPage.getConversationIdFromUrl();
      expect(sameConversationId).toBe(conversationId);
    },
    { timeout: TIMEOUTS.clarification * 2 + 30000 }
  );

  test(
    'clarification flow recovers from errors',
    async () => {
      await chatPage.sendMessage(
        'Create MCP for https://invalid-url-that-will-fail'
      );

      // Wait for response (error or clarification)
      await chatPage.waitForAssistantResponse(TIMEOUTS.clarification);

      // Try again with valid request
      await chatPage.sendMessage(
        'Let me try again: Create MCP for the Stripe API'
      );
      await chatPage.waitForGenerationComplete(TIMEOUTS.generation);

      const response = await chatPage.getLastAssistantMessage();
      expect(response.toLowerCase()).toMatch(/stripe|payment/);
    },
    { timeout: TIMEOUTS.generation + TIMEOUTS.clarification + 30000 }
  );
});
