import { test, expect } from '@playwright/test';
import { ChatE2EPage } from '../../page-objects/chat-e2e.page';

/**
 * E2E Test Suite: Natural Language Generation Flow
 *
 * These tests validate MCP server generation using natural language descriptions
 * as input. This tests the AI's ability to understand user intent without explicit
 * service names or URLs.
 *
 * Flow:
 * 1. User provides natural language description
 * 2. AI interprets intent and requirements
 * 3. May ask clarifying questions for vague requests
 * 4. Designs tools based on described functionality
 * 5. Generates custom MCP server implementation
 *
 * Requirements:
 * - Real backend running (no mocks)
 * - Claude API key configured
 * - Tests use real AI generation (5+ minute timeouts)
 */

// Test descriptions covering various input types
const TEST_DESCRIPTIONS = {
  // Specific tool descriptions
  specific: `Create an MCP server with the following tools:
    1. Temperature converter (Celsius to Fahrenheit and vice versa)
    2. BMI calculator (takes height and weight)
    3. Password generator (configurable length and complexity)`,

  // Task-based description
  taskBased: `I need an MCP server that helps me manage my personal TODO list.
    I want to be able to add tasks, mark them complete, list pending tasks,
    and delete completed tasks.`,

  // Very specific requirements
  detailed: `Build an MCP server for a weather service that:
    - Gets current weather for any city
    - Gets 5-day forecast
    - Returns data in metric units
    - Handles city not found errors gracefully`,

  // Vague request
  vague: 'Make me an MCP server',

  // Unrealistic request
  unrealistic: 'Create an MCP server that can predict lottery numbers',

  // Multi-line with examples
  withExamples: `Create an MCP server for currency conversion.
    Example: convert 100 USD to EUR
    Example: get exchange rate for GBP to JPY
    Should support all major currencies.`,
};

// Extended timeouts for real AI generation
const TIMEOUTS = {
  generation: 300000, // 5 minutes for full generation
  phase: 60000, // 60 seconds per phase
  response: 60000, // 60 seconds for quick responses
  action: 30000, // 30 seconds for UI actions
};

test.describe('Natural Language Generation Flow', () => {
  let chatPage: ChatE2EPage;

  test.beforeEach(async ({ page }) => {
    chatPage = new ChatE2EPage(page);
    await chatPage.navigate();
  });

  test.describe('Specific Tool Descriptions', () => {
    test(
      'generates MCP server from specific tool description',
      async () => {
        const result = await chatPage.sendAndWaitForGeneration(
          TEST_DESCRIPTIONS.specific,
          TIMEOUTS.generation
        );

        // Should generate with download
        expect(result.success).toBe(true);
        expect(result.hasDownload).toBe(true);

        // Response should mention the tools
        const response = result.finalResponse.toLowerCase();
        expect(response).toMatch(/temperature|converter/);
        expect(response).toMatch(/bmi|calculator/);
        expect(response).toMatch(/password|generator/);
      },
      { timeout: TIMEOUTS.generation + 30000 }
    );

    test(
      'generates task management MCP server',
      async () => {
        await chatPage.sendMessage(TEST_DESCRIPTIONS.taskBased);

        await chatPage.waitForGenerationComplete(TIMEOUTS.generation);

        const response = await chatPage.getLastAssistantMessage();
        expect(response.toLowerCase()).toMatch(/todo|task/);
        expect(response.toLowerCase()).toMatch(
          /add|create|list|complete|delete/
        );
      },
      { timeout: TIMEOUTS.generation + 30000 }
    );

    test(
      'handles detailed requirements',
      async () => {
        await chatPage.sendMessage(TEST_DESCRIPTIONS.detailed);

        await chatPage.waitForGenerationComplete(TIMEOUTS.generation);

        const response = await chatPage.getLastAssistantMessage();
        expect(response.toLowerCase()).toMatch(/weather|forecast/);
      },
      { timeout: TIMEOUTS.generation + 30000 }
    );
  });

  test.describe('Clarification Requests', () => {
    test(
      'asks for clarification on vague requests',
      async () => {
        await chatPage.sendMessage(TEST_DESCRIPTIONS.vague);

        // Should respond quickly with clarification request
        await chatPage.waitForAssistantResponse(TIMEOUTS.response);

        const response = await chatPage.getLastAssistantMessage();

        // Should ask what kind of MCP server
        expect(response.toLowerCase()).toMatch(
          /what|which|kind|type|specific|more|details/
        );
      },
      { timeout: TIMEOUTS.response + 30000 }
    );

    test(
      'handles unrealistic requests appropriately',
      async () => {
        await chatPage.sendMessage(TEST_DESCRIPTIONS.unrealistic);

        await chatPage.waitForAssistantResponse(TIMEOUTS.response);

        const response = await chatPage.getLastAssistantMessage();

        // Should handle gracefully (explain, redirect, or clarify)
        expect(response.length).toBeGreaterThan(0);
        // Might explain limitations or suggest alternatives
      },
      { timeout: TIMEOUTS.response + 30000 }
    );

    test(
      'follows up on natural language with specific questions',
      async () => {
        // Start vague
        await chatPage.sendMessage(
          'I need an MCP server for data processing'
        );
        await chatPage.waitForAssistantResponse(TIMEOUTS.response);

        // Clarify
        await chatPage.sendMessage(
          'CSV files - I want to read, filter, and export them'
        );
        await chatPage.waitForGenerationComplete(TIMEOUTS.generation);

        const response = await chatPage.getLastAssistantMessage();
        expect(response.toLowerCase()).toMatch(/csv|file|read|filter|export/);
      },
      { timeout: TIMEOUTS.generation + TIMEOUTS.response + 30000 }
    );
  });

  test.describe('Complex Descriptions', () => {
    test(
      'understands examples in description',
      async () => {
        await chatPage.sendMessage(TEST_DESCRIPTIONS.withExamples);

        await chatPage.waitForGenerationComplete(TIMEOUTS.generation);

        const response = await chatPage.getLastAssistantMessage();
        expect(response.toLowerCase()).toMatch(/currency|convert|exchange/);
      },
      { timeout: TIMEOUTS.generation + 30000 }
    );

    test(
      'multi-line descriptions are parsed correctly',
      async () => {
        const multiLine = `Create an MCP server with:
    - Tool 1: Get current time
    - Tool 2: Get current date
    - Tool 3: Calculate time difference`;

        await chatPage.sendMessage(multiLine);
        await chatPage.waitForGenerationComplete(TIMEOUTS.generation);

        const response = await chatPage.getLastAssistantMessage();
        expect(response.toLowerCase()).toMatch(/time|date/);
      },
      { timeout: TIMEOUTS.generation + 30000 }
    );

    test(
      'handles special characters in description',
      async () => {
        const withSpecialChars = `Create an MCP server for:
    - JSON parsing (handle {objects} and [arrays])
    - Path manipulation (/home/user/docs/*.txt)
    - URL encoding (handle ? & = characters)`;

        await chatPage.sendMessage(withSpecialChars);

        // Should not crash, should respond
        await chatPage.waitForAssistantResponse(TIMEOUTS.response);
        const response = await chatPage.getLastAssistantMessage();
        expect(response.length).toBeGreaterThan(0);
      },
      { timeout: TIMEOUTS.generation + 30000 }
    );
  });
});
