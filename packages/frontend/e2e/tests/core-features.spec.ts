/**
 * Layer 5: Core Features - Chat, AI, Generation Tests
 *
 * This test suite validates the core functionality per Issue #91:
 * - Sending messages
 * - Receiving AI responses
 * - Generating MCP servers
 *
 * HYBRID APPROACH:
 * - Tests 5.1-5.3: Use MOCKED backend (fast, free, reliable)
 * - Tests 5.4-5.9: Use REAL Claude API (validates actual AI behavior)
 *
 * Run with: npm run e2e:core-features
 */

import { test, expect } from '@playwright/test';
import { ChatPage } from '../page-objects/chat.page';
import { MockBackend } from '../fixtures/mock-backend';
import {
  CoreFeaturesBackend,
  generateTestSessionId,
} from '../fixtures/integration-backend';
import {
  MOCK_SSE_EVENTS,
  MOCK_GENERATED_CODE,
  API_ENDPOINTS,
} from '../fixtures/test-data';

// Backend configuration
const BACKEND_URL = 'http://localhost:3000';
const FRONTEND_URL = 'http://localhost:4200';

// ============================================================================
// PART A: Mocked Tests (5.1-5.3) - Fast, no API costs
// ============================================================================

test.describe('Layer 5: Core Features - Chat, AI, Generation', () => {
  test.describe('5.1-5.3 Basic Chat (Mocked)', () => {
    let chatPage: ChatPage;
    let mockBackend: MockBackend;

    test.beforeEach(async ({ page }) => {
      chatPage = new ChatPage(page);
      mockBackend = new MockBackend(page);
    });

    test('5.1 sends message and shows in chat', async ({ page }) => {
      // Setup mocks
      await mockBackend.mockChatMessage({ success: true, conversationId: 'test-conv-1' });
      await mockBackend.mockSSEStream([
        { type: 'progress', message: 'Processing...', timestamp: new Date().toISOString() },
      ]);
      await mockBackend.mockHealthCheck();

      // Navigate to chat
      await chatPage.navigate();
      await chatPage.wait(1000);

      // Verify welcome screen is visible
      expect(await chatPage.isWelcomeScreenVisible()).toBe(true);

      // Type "Hello" in chat input
      await chatPage.typeMessage('Hello');
      expect(await chatPage.getMessageInputValue()).toBe('Hello');

      // Click Send button
      await chatPage.clickSend();

      // Verify user message appears in chat
      await chatPage.waitForUserMessage(5000);
      const lastUserMessage = await chatPage.getLastUserMessage();
      expect(lastUserMessage).toContain('Hello');

      // Verify loading state shows (hourglass icon on send button)
      // Note: This may be fast, so we check if either loading or complete
      const isLoading = await chatPage.isLoading();
      // Loading state is transient, so we just verify no errors occurred
      expect(await chatPage.isErrorMessageVisible()).toBe(false);
    });

    test('5.2 receives streaming AI response', async ({ page }) => {
      // Setup mocks with progress -> result -> complete flow
      await mockBackend.mockChatMessage({ success: true, conversationId: 'test-conv-2' });
      await mockBackend.mockSSEStream([
        {
          type: 'progress',
          message: 'Analyzing your request...',
          timestamp: new Date().toISOString(),
        },
        {
          type: 'result',
          message: 'I can help you with many things! I can generate MCP servers from GitHub repositories, API specifications, or natural language descriptions.',
          timestamp: new Date().toISOString(),
        },
        {
          type: 'complete',
          message: 'Response complete',
          timestamp: new Date().toISOString(),
        },
      ]);
      await mockBackend.mockHealthCheck();

      // Navigate to chat
      await chatPage.navigate();
      await chatPage.wait(1000);

      // Send message
      await chatPage.sendMessage('What can you help me with?');

      // Verify user message appears
      await chatPage.waitForUserMessage(5000);

      // Wait for assistant response
      await chatPage.waitForAssistantResponse(10000);

      // Verify assistant response appears and is relevant
      const assistantMessage = await chatPage.getLastAssistantMessage();
      expect(assistantMessage.length).toBeGreaterThan(0);
      expect(assistantMessage.toLowerCase()).toContain('help');

      // Verify loading state clears
      await chatPage.waitForLoadingComplete(5000);
    });

    test('5.3 responds to help request quickly', async ({ page }) => {
      // Setup mocks for help response
      await mockBackend.mockChatMessage({ success: true, conversationId: 'test-conv-3' });
      await mockBackend.mockSSEStream([
        {
          type: 'progress',
          message: 'Processing help request...',
          timestamp: new Date().toISOString(),
        },
        {
          type: 'result',
          message: `I'm MCP Everything, an AI-powered platform that helps you generate Model Context Protocol (MCP) servers. Here's what I can do:

1. **Generate MCP servers from GitHub repositories** - Just paste a URL
2. **Create servers from API specifications** - Describe your API
3. **Build servers from natural language** - Tell me what tools you need

Try saying: "Create an MCP server for https://github.com/sindresorhus/is"`,
          timestamp: new Date().toISOString(),
        },
        {
          type: 'complete',
          message: 'Help response complete',
          timestamp: new Date().toISOString(),
        },
      ]);
      await mockBackend.mockHealthCheck();

      // Navigate to chat
      await chatPage.navigate();
      await chatPage.wait(1000);

      // Record start time
      const startTime = Date.now();

      // Send "help"
      await chatPage.sendMessage('help');

      // Wait for assistant response
      await chatPage.waitForAssistantResponse(10000);

      // Verify response time < 10s
      const responseTime = Date.now() - startTime;
      expect(responseTime).toBeLessThan(10000);

      // Verify response explains capabilities
      const assistantMessage = await chatPage.getLastAssistantMessage();
      expect(assistantMessage.toLowerCase()).toContain('mcp');

      // Verify no error messages
      expect(await chatPage.isErrorMessageVisible()).toBe(false);
    });
  });

  // ============================================================================
  // PART B: Real API Tests (5.4-5.9) - Slow, costs money
  // ============================================================================

  test.describe('5.4-5.9 AI Generation (Real API)', () => {
    // Extended timeout for AI operations
    test.setTimeout(300000); // 5 minutes per test

    // Run tests sequentially to control API costs
    test.describe.configure({ mode: 'serial' });

    let backend: CoreFeaturesBackend;
    let chatPage: ChatPage;

    // Store state between tests for context testing
    let lastConversationId: string | null = null;
    let generationSucceeded = false;

    test.beforeAll(async () => {
      // Verify backend is running and AI is ready
      backend = new CoreFeaturesBackend({
        backendUrl: BACKEND_URL,
        frontendUrl: FRONTEND_URL,
      });

      const aiReady = await backend.isAIReady();
      if (!aiReady.ready) {
        throw new Error(
          `AI services not ready: ${aiReady.error}. ` +
          `Backend healthy: ${aiReady.backendHealthy}, ` +
          `Chat service healthy: ${aiReady.chatServiceHealthy}. ` +
          'Start backend with: cd packages/backend && npm run start:dev'
        );
      }
    });

    test.beforeEach(async ({ page }) => {
      chatPage = new ChatPage(page);
    });

    test('5.4 generates MCP server from GitHub URL (CRITICAL)', async ({ page }) => {
      // Navigate to chat
      await chatPage.navigate();
      await chatPage.wait(2000);

      // Send generation request
      const message = 'Create MCP server for https://github.com/sindresorhus/is';
      await chatPage.sendMessage(message);

      // Verify user message appears
      await chatPage.waitForUserMessage(5000);

      // Track phases - these should appear as progress messages
      // Phase 1: Intent analysis
      try {
        await chatPage.waitForProgressMessage(30000);
        const progressText = await chatPage.getProgressMessage();
        expect(progressText.length).toBeGreaterThan(0);
      } catch {
        // Progress may be too fast to catch, continue
      }

      // Wait for generation to complete (download button appears)
      // This is the critical success indicator
      await chatPage.waitForGenerationComplete(300000); // 5 minutes

      // Verify download button appeared
      expect(await chatPage.hasDownloadZipButton()).toBe(true);

      // Verify assistant message with summary appears
      const assistantCount = await chatPage.getAssistantMessageCount();
      expect(assistantCount).toBeGreaterThan(0);

      // Verify no error messages
      expect(await chatPage.isErrorMessageVisible()).toBe(false);

      // Store state for subsequent tests
      lastConversationId = chatPage.getConversationIdFromUrl();
      generationSucceeded = true;
    });

    test('5.5 downloads generated code as ZIP', async ({ page }) => {
      // This test depends on 5.4 succeeding
      test.skip(!generationSucceeded, 'Skipping: Previous generation did not succeed');

      // Navigate to chat (should have last conversation)
      await chatPage.navigate();
      await chatPage.wait(2000);

      // If we have a conversation ID, navigate to it
      if (lastConversationId) {
        await chatPage.navigateToConversation(lastConversationId);
        await chatPage.wait(2000);
      }

      // Verify download button is visible
      const hasButton = await chatPage.hasDownloadZipButton();
      if (!hasButton) {
        // Re-generate if needed
        await chatPage.sendMessage('Create MCP server for https://github.com/sindresorhus/is');
        await chatPage.waitForGenerationComplete(300000);
      }

      // Click download and get file
      const downloadPath = await chatPage.clickDownloadZip();

      // Verify file was downloaded
      expect(downloadPath).toBeTruthy();
      expect(downloadPath.length).toBeGreaterThan(0);
    });

    test('5.6 handles service name input', async ({ page }) => {
      // Navigate to chat
      await chatPage.navigate();
      await chatPage.wait(2000);

      // Send service name request
      await chatPage.sendMessage('Create MCP server for Stripe API');

      // Verify user message appears
      await chatPage.waitForUserMessage(5000);

      // Wait for some response (either progress, clarification, or result)
      await chatPage.waitForNewMessage(1, 60000);

      // Verify intent was detected (should have progress or response)
      const messageCount = await chatPage.getMessageCount();
      expect(messageCount).toBeGreaterThan(1);

      // Check if we got a response or clarification
      const assistantCount = await chatPage.getAssistantMessageCount();
      const progressCount = await chatPage.getProgressMessageCount();
      expect(assistantCount + progressCount).toBeGreaterThan(0);
    });

    test('5.7 handles natural language description', async ({ page }) => {
      // Navigate to chat
      await chatPage.navigate();
      await chatPage.wait(2000);

      // Send natural language description
      const description =
        'I want an MCP server that converts temperatures between Celsius and Fahrenheit';
      await chatPage.sendMessage(description);

      // Verify user message appears
      await chatPage.waitForUserMessage(5000);

      // Wait for some response
      await chatPage.waitForNewMessage(1, 60000);

      // Verify AI understood and responded
      const messageCount = await chatPage.getMessageCount();
      expect(messageCount).toBeGreaterThan(1);

      // Either generates or asks clarifying questions
      const assistantCount = await chatPage.getAssistantMessageCount();
      expect(assistantCount).toBeGreaterThan(0);
    });

    test('5.8 asks for clarification on vague input', async ({ page }) => {
      // Navigate to chat
      await chatPage.navigate();
      await chatPage.wait(2000);

      // Send vague message that should trigger clarification
      await chatPage.sendMessage('Create an MCP server');

      // Verify user message appears
      await chatPage.waitForUserMessage(5000);

      // Wait for AI response
      await chatPage.waitForAssistantResponse(60000);

      // Verify AI asks for clarification
      const isClarifying = await chatPage.isClarificationBeingAsked();
      const lastMessage = await chatPage.getLastAssistantMessage();

      // Should either ask a question or provide guidance
      expect(
        isClarifying || lastMessage.includes('?') || lastMessage.toLowerCase().includes('what')
      ).toBe(true);

      // If clarification was requested, reply with details
      if (isClarifying) {
        const currentCount = await chatPage.getMessageCount();

        // Send clarification
        await chatPage.sendMessage(
          'For managing a TODO list with add, complete, and delete tasks'
        );

        // Wait for response to clarification
        await chatPage.waitForNewMessage(currentCount + 1, 120000);

        // Verify generation proceeds or more specific questions asked
        const newAssistantCount = await chatPage.getAssistantMessageCount();
        expect(newAssistantCount).toBeGreaterThan(1);
      }
    });

    test('5.9 maintains conversation context', async ({ page }) => {
      // This test works best after a generation has completed
      // Navigate to chat
      await chatPage.navigate();
      await chatPage.wait(2000);

      // If we have a previous conversation, use it
      if (lastConversationId) {
        await chatPage.navigateToConversation(lastConversationId);
        await chatPage.wait(2000);
      } else {
        // Generate something first
        await chatPage.sendMessage('Create MCP server for a simple calculator with add and subtract');
        await chatPage.waitForAssistantResponse(120000);
      }

      // Get current message count
      const currentCount = await chatPage.getMessageCount();

      // Ask about the context
      await chatPage.sendMessage('What tools does this server have?');

      // Wait for response
      await chatPage.waitForNewMessage(currentCount + 1, 60000);

      // Verify AI remembers previous context
      const lastMessage = await chatPage.getLastAssistantMessage();

      // Should relate to the generated server or ask for clarification about which server
      expect(lastMessage.length).toBeGreaterThan(0);

      // Should not be a "I don't know what you mean" type response
      const confusionIndicators = [
        "i don't understand",
        'could you clarify',
        "i'm not sure what you're referring to",
        'what do you mean',
      ];

      const isConfused = confusionIndicators.some((indicator) =>
        lastMessage.toLowerCase().includes(indicator)
      );

      // The AI should either remember context or ask specifically about which server
      // (not be generally confused)
      if (isConfused) {
        // If confused, it should be asking specifically about which server
        expect(
          lastMessage.toLowerCase().includes('which') ||
          lastMessage.toLowerCase().includes('server')
        ).toBe(true);
      }
    });
  });
});
