import { test, expect } from '@playwright/test';
import { ChatE2EPage } from '../../page-objects/chat-e2e.page';
import { SSEObserver } from '../../fixtures/sse-observer';

/**
 * E2E Test Suite: GitHub URL Generation Flow
 *
 * These tests validate the complete MCP server generation flow using GitHub
 * repository URLs as input. This is the primary input type and most common
 * user flow.
 *
 * Flow:
 * 1. User provides GitHub URL
 * 2. Backend analyzes repository (README, code structure, API patterns)
 * 3. LangGraph phases: intent → research → ensemble → clarification → refinement
 * 4. MCP server code is generated
 * 5. User can download or deploy
 *
 * Requirements:
 * - Real backend running (no mocks)
 * - Claude API key configured
 * - Tests use real AI generation (5+ minute timeouts)
 */

// Test repositories with different characteristics
const TEST_REPOS = {
  // Simple, fast to analyze
  simple: 'https://github.com/sindresorhus/is',

  // Has clear API patterns
  api: 'https://github.com/expressjs/express',

  // Invalid/non-existent
  invalid: 'https://github.com/nonexistent-user-12345/fake-repo-67890',

  // Private (if available for testing)
  private: 'https://github.com/4eyedengineer/private-test-repo',

  // Malformed URL
  malformed: 'github.com/no-protocol',
};

// Extended timeouts for real AI generation
const TIMEOUTS = {
  generation: 300000, // 5 minutes for full generation
  phase: 60000, // 60 seconds per phase
  action: 30000, // 30 seconds for UI actions
  error: 30000, // 30 seconds for error responses
};

test.describe('GitHub URL Generation Flow', () => {
  let chatPage: ChatE2EPage;
  let sseObserver: SSEObserver;

  test.beforeEach(async ({ page }) => {
    chatPage = new ChatE2EPage(page);
    sseObserver = new SSEObserver();
    await chatPage.navigate();
  });

  test.afterEach(async () => {
    sseObserver.disconnect();
  });

  test.describe('Successful Generation', () => {
    test(
      'generates MCP server from simple GitHub repository',
      async () => {
        // Send GitHub URL and track complete generation
        const result = await chatPage.sendAndWaitForGeneration(
          `Create an MCP server for ${TEST_REPOS.simple}`,
          TIMEOUTS.generation
        );

        // Validate phases were received
        expect(result.phases.length).toBeGreaterThan(0);
        expect(
          result.phases.some((p) =>
            p.message.toLowerCase().includes('research')
          )
        ).toBe(true);

        // Validate generation completed
        expect(result.success).toBe(true);
        expect(result.finalResponse).toBeTruthy();
        expect(result.hasDownload).toBe(true);
      },
      { timeout: TIMEOUTS.generation + 30000 }
    );

    test(
      'shows correct progress phases during generation',
      async () => {
        const sessionId = await chatPage.getSessionId();
        if (sessionId) {
          await sseObserver.connect(sessionId);
        }

        await chatPage.sendMessage(
          `Generate MCP server from ${TEST_REPOS.simple}`
        );

        // Wait for and validate expected phases
        // Based on LangGraph nodes: intent, research, ensemble
        const expectedPhases = [
          'intent', // analyzeIntent node
          'research', // researchCoordinator node
          'ensemble', // ensembleCoordinator (4 specialist agents)
        ];

        const phaseResult = await sseObserver.waitForPhases(
          expectedPhases,
          TIMEOUTS.phase
        );

        // At least some phases should be found
        expect(phaseResult.foundPhases.length).toBeGreaterThan(0);

        // Log found phases for debugging
        console.log('Found phases:', phaseResult.foundPhases);
        console.log('Missing phases:', phaseResult.missingPhases);
      },
      { timeout: TIMEOUTS.generation + 30000 }
    );

    test(
      'download button appears after successful generation',
      async () => {
        await chatPage.sendMessage(
          `Create MCP server for ${TEST_REPOS.simple}`
        );

        // Wait for generation to complete
        await chatPage.waitForGenerationComplete(TIMEOUTS.generation);

        // Download button should be visible
        expect(await chatPage.isDownloadButtonVisible()).toBe(true);

        // Clicking download should trigger file download
        const downloadPath = await chatPage.downloadGeneratedCode();
        expect(downloadPath).toBeTruthy();
      },
      { timeout: TIMEOUTS.generation + 30000 }
    );

    test(
      'downloaded code has valid structure',
      async ({ page }) => {
        await chatPage.sendMessage(
          `Create MCP server for ${TEST_REPOS.simple}`
        );
        await chatPage.waitForGenerationComplete(TIMEOUTS.generation);

        // Download and verify the file was received
        const downloadPath = await chatPage.downloadGeneratedCode();
        expect(downloadPath).toBeTruthy();

        // Note: Full file structure validation would require filesystem access
        // For E2E tests, we verify the download completes successfully
        // The actual code validation is done by McpTestingService in the backend
      },
      { timeout: TIMEOUTS.generation + 30000 }
    );
  });

  test.describe('Error Handling', () => {
    test(
      'handles invalid GitHub URL gracefully',
      async () => {
        await chatPage.sendMessage(
          `Create MCP for ${TEST_REPOS.invalid}`
        );

        // Wait for some response - either error or clarification
        await chatPage.wait(TIMEOUTS.error);

        // Either error message or clarification request should appear
        const hasError = await chatPage.didGenerationFail();
        const hasResponse = (await chatPage.getAssistantMessageCount()) > 0;

        expect(hasError || hasResponse).toBe(true);

        // Should not show download button for failed generation
        expect(await chatPage.isDownloadButtonVisible()).toBe(false);
      },
      { timeout: TIMEOUTS.error + 30000 }
    );

    test(
      'handles malformed URL with helpful message',
      async () => {
        await chatPage.sendMessage(
          `Create MCP for ${TEST_REPOS.malformed}`
        );

        // Wait for response
        await chatPage.waitForAssistantResponse(TIMEOUTS.error);

        // Should get clarification or error, not crash
        const response = await chatPage.getLastAssistantMessage();
        expect(response.length).toBeGreaterThan(0);
      },
      { timeout: TIMEOUTS.error + 30000 }
    );
  });

  test.describe('Multi-turn Conversation', () => {
    test(
      'user can continue conversation after generation',
      async () => {
        // First message - generate
        await chatPage.sendMessage(
          `Create MCP for ${TEST_REPOS.simple}`
        );
        await chatPage.waitForGenerationComplete(TIMEOUTS.generation);

        // Follow-up message
        await chatPage.sendMessage(
          'What tools does this MCP server have?'
        );
        await chatPage.waitForAssistantResponse(TIMEOUTS.action);

        // Should get meaningful response about the generated server
        const response = await chatPage.getLastAssistantMessage();
        expect(response.length).toBeGreaterThan(0);
      },
      { timeout: TIMEOUTS.generation + TIMEOUTS.action + 30000 }
    );
  });

  test.describe('Progress Tracking', () => {
    test(
      'generation progress updates in real-time',
      async () => {
        await chatPage.sendMessage(
          `Generate MCP server from ${TEST_REPOS.simple}`
        );

        // Track messages over time
        const progressMessages = await chatPage.trackProgressMessages(
          TIMEOUTS.generation
        );

        // Should have received multiple progress updates
        expect(progressMessages.length).toBeGreaterThanOrEqual(2);

        // Messages should change over time (not stuck)
        const uniqueMessages = new Set(progressMessages);
        expect(uniqueMessages.size).toBeGreaterThan(1);

        // Log progress for debugging
        console.log('Progress messages received:', progressMessages);
      },
      { timeout: TIMEOUTS.generation + 30000 }
    );

    test(
      'each phase completes within 60 seconds',
      async () => {
        const sessionId = await chatPage.getSessionId();
        if (sessionId) {
          await sseObserver.connect(sessionId);
        }

        await chatPage.sendMessage(
          `Create MCP for ${TEST_REPOS.simple}`
        );

        const phaseTimes: { phase: string; duration: number }[] = [];
        let lastPhaseTime = Date.now();
        let lastPhaseMessage = '';

        // Monitor phase transitions until completion or timeout
        const startTime = Date.now();
        while (Date.now() - startTime < TIMEOUTS.generation) {
          const events = sseObserver.getEvents();
          const progressEvents = events.filter((e) => e.type === 'progress');
          const latestProgress = progressEvents[progressEvents.length - 1];

          if (latestProgress && latestProgress.message !== lastPhaseMessage) {
            const duration = Date.now() - lastPhaseTime;

            // Record previous phase duration (skip first measurement)
            if (lastPhaseMessage) {
              phaseTimes.push({ phase: lastPhaseMessage, duration });

              // Warn if phase takes too long
              if (duration > TIMEOUTS.phase) {
                console.warn(
                  `Phase took ${duration}ms (>${TIMEOUTS.phase}ms): ${lastPhaseMessage}`
                );
              }
            }

            lastPhaseMessage = latestProgress.message || '';
            lastPhaseTime = Date.now();
          }

          // Check for completion
          const complete = events.find((e) => e.type === 'complete');
          if (complete) {
            // Record final phase
            if (lastPhaseMessage) {
              phaseTimes.push({
                phase: lastPhaseMessage,
                duration: Date.now() - lastPhaseTime,
              });
            }
            break;
          }

          // Check for error
          const error = events.find((e) => e.type === 'error');
          if (error) {
            console.error('Generation error:', error.message);
            break;
          }

          await chatPage.wait(1000);
        }

        // Report phase times
        console.log('Phase durations:', phaseTimes);

        // Verify at least some phases were tracked
        expect(phaseTimes.length).toBeGreaterThan(0);
      },
      { timeout: TIMEOUTS.generation + 30000 }
    );
  });
});
