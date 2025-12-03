import { Page, Locator } from '@playwright/test';
import { ChatPage } from './chat.page';

/**
 * Represents a single phase of the MCP server generation process
 */
export interface GenerationPhase {
  name: string;
  message: string;
  timestamp: Date;
  duration?: number;
}

/**
 * Complete result of an MCP server generation attempt
 */
export interface GenerationResult {
  success: boolean;
  phases: GenerationPhase[];
  finalResponse: string;
  hasDownload: boolean;
  hasDeployButton: boolean;
  totalDuration: number;
  error?: string;
}

/**
 * Information about a deployed MCP server
 */
export interface DeploymentInfo {
  serverId: string;
  endpoint: string;
  status: string;
}

/**
 * Extended ChatPage for E2E tests with real AI generation
 * Provides extended timeouts, phase tracking, and deployment info extraction
 */
export class ChatE2EPage extends ChatPage {
  // Extended timeout constants for real AI generation
  static readonly PHASE_TIMEOUT = 60000;       // 60s per phase
  static readonly GENERATION_TIMEOUT = 300000; // 5 min total
  static readonly DEPLOYMENT_TIMEOUT = 120000; // 2 min for deploy

  // Additional locators for deployment
  readonly deployButton: Locator;
  readonly cloudButton: Locator;
  readonly deploymentResultCard: Locator;
  readonly deploymentErrorCard: Locator;
  readonly deploymentActions: Locator;

  constructor(page: Page) {
    super(page);

    // Initialize deployment-related locators
    this.deployButton = page.locator('button').filter({ hasText: /host|deploy|cloud/i });
    this.cloudButton = page.locator('.cloud-button');
    this.deploymentResultCard = page.locator('.deployment-result-card');
    this.deploymentErrorCard = page.locator('.deployment-error-card');
    this.deploymentActions = page.locator('.deployment-actions');
  }

  /**
   * Send message and wait for complete generation with phase tracking
   * @param message - The message to send
   * @param timeout - Total timeout (default 5 minutes)
   */
  async sendAndWaitForGeneration(
    message: string,
    timeout: number = ChatE2EPage.GENERATION_TIMEOUT
  ): Promise<GenerationResult> {
    const startTime = Date.now();
    const phases: GenerationPhase[] = [];
    let lastPhase: string | null = null;
    let phaseStartTime = startTime;

    // Send the message
    await this.sendMessage(message);

    // Track phases until completion
    while (Date.now() - startTime < timeout) {
      // Check for error
      if (await this.didGenerationFail()) {
        const error = await this.getGenerationError();
        return {
          success: false,
          phases,
          finalResponse: '',
          hasDownload: false,
          hasDeployButton: false,
          totalDuration: Date.now() - startTime,
          error: error || 'Generation failed',
        };
      }

      // Check for completion
      if (await this.didGenerationSucceed()) {
        // Record final phase duration
        if (lastPhase && phases.length > 0) {
          phases[phases.length - 1].duration = Date.now() - phaseStartTime;
        }

        const finalResponse = await this.getLastAssistantMessage();
        const hasDownload = await this.isDownloadButtonVisible();
        const hasDeployButton = await this.isDeployButtonVisible();

        return {
          success: true,
          phases,
          finalResponse,
          hasDownload,
          hasDeployButton,
          totalDuration: Date.now() - startTime,
        };
      }

      // Track current phase
      const currentPhase = await this.getCurrentPhase();
      if (currentPhase && currentPhase !== lastPhase) {
        // Record previous phase duration
        if (lastPhase && phases.length > 0) {
          phases[phases.length - 1].duration = Date.now() - phaseStartTime;
        }

        // Add new phase
        phases.push({
          name: this.extractPhaseName(currentPhase),
          message: currentPhase,
          timestamp: new Date(),
        });

        lastPhase = currentPhase;
        phaseStartTime = Date.now();
      }

      await this.wait(500);
    }

    // Timeout
    return {
      success: false,
      phases,
      finalResponse: '',
      hasDownload: false,
      hasDeployButton: false,
      totalDuration: Date.now() - startTime,
      error: 'Generation timed out',
    };
  }

  /**
   * Track progress messages over time
   * Returns array of all progress messages seen
   */
  async trackProgressMessages(
    timeout: number = ChatE2EPage.GENERATION_TIMEOUT
  ): Promise<string[]> {
    const messages: string[] = [];
    const startTime = Date.now();
    const seenMessages = new Set<string>();

    while (Date.now() - startTime < timeout) {
      const currentMessages = await this.getAllProgressMessages();

      // Record new messages
      for (const msg of currentMessages) {
        if (!seenMessages.has(msg)) {
          seenMessages.add(msg);
          messages.push(msg);
        }
      }

      // Check if generation completed
      if (await this.didGenerationSucceed() || await this.didGenerationFail()) {
        break;
      }

      await this.wait(500);
    }

    return messages;
  }

  /**
   * Wait for specific progress phase by text content
   * @param phaseText - Text to match in progress message
   * @param timeout - Timeout per phase (default 60s)
   */
  async waitForPhase(
    phaseText: string,
    timeout: number = ChatE2EPage.PHASE_TIMEOUT
  ): Promise<GenerationPhase> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const currentPhase = await this.getCurrentPhase();

      if (currentPhase && currentPhase.toLowerCase().includes(phaseText.toLowerCase())) {
        return {
          name: this.extractPhaseName(currentPhase),
          message: currentPhase,
          timestamp: new Date(),
          duration: Date.now() - startTime,
        };
      }

      // Check for completion or error
      if (await this.didGenerationSucceed() || await this.didGenerationFail()) {
        throw new Error(`Generation completed before phase "${phaseText}" was reached`);
      }

      await this.wait(500);
    }

    throw new Error(`Timeout waiting for phase "${phaseText}"`);
  }

  /**
   * Wait for multiple expected phases in order
   * @param expectedPhases - Array of phase text patterns
   * @param phaseTimeout - Timeout per phase (default 60s)
   */
  async waitForPhasesSequence(
    expectedPhases: string[],
    phaseTimeout: number = ChatE2EPage.PHASE_TIMEOUT
  ): Promise<{
    foundPhases: GenerationPhase[];
    missingPhases: string[];
  }> {
    const foundPhases: GenerationPhase[] = [];
    const missingPhases: string[] = [];
    let phaseIndex = 0;

    const startTime = Date.now();
    const totalTimeout = phaseTimeout * expectedPhases.length;

    while (phaseIndex < expectedPhases.length && Date.now() - startTime < totalTimeout) {
      const expectedPhase = expectedPhases[phaseIndex];

      try {
        const phase = await this.waitForPhase(expectedPhase, phaseTimeout);
        foundPhases.push(phase);
        phaseIndex++;
      } catch (error) {
        // Phase not found or generation ended
        if (await this.didGenerationSucceed() || await this.didGenerationFail()) {
          // Generation ended - remaining phases are missing
          for (let i = phaseIndex; i < expectedPhases.length; i++) {
            missingPhases.push(expectedPhases[i]);
          }
          break;
        }
        // Timeout for this phase
        missingPhases.push(expectedPhase);
        phaseIndex++;
      }
    }

    return { foundPhases, missingPhases };
  }

  /**
   * Wait for generation to complete (assistant message appears after progress)
   * @param timeout - Total timeout (default 5 minutes)
   */
  async waitForGenerationComplete(
    timeout: number = ChatE2EPage.GENERATION_TIMEOUT
  ): Promise<{
    response: string;
    hasDownload: boolean;
    duration: number;
  }> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      if (await this.didGenerationSucceed()) {
        const response = await this.getLastAssistantMessage();
        const hasDownload = await this.isDownloadButtonVisible();

        return {
          response,
          hasDownload,
          duration: Date.now() - startTime,
        };
      }

      if (await this.didGenerationFail()) {
        const error = await this.getGenerationError();
        throw new Error(`Generation failed: ${error}`);
      }

      await this.wait(500);
    }

    throw new Error('Timeout waiting for generation to complete');
  }

  /**
   * Check if "Host on Cloud" / deploy button is visible
   */
  async isDeployButtonVisible(): Promise<boolean> {
    try {
      const cloudVisible = await this.cloudButton.isVisible();
      if (cloudVisible) return true;

      const deployVisible = await this.deployButton.first().isVisible();
      return deployVisible;
    } catch {
      return false;
    }
  }

  /**
   * Click the deploy button
   */
  async clickDeployButton(): Promise<void> {
    // Prefer cloud button if visible
    if (await this.cloudButton.isVisible()) {
      await this.cloudButton.click();
    } else {
      await this.deployButton.first().click();
    }
  }

  /**
   * Wait for deploy button to appear after generation
   */
  async waitForDeployButton(
    timeout: number = ChatE2EPage.GENERATION_TIMEOUT
  ): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      if (await this.isDeployButtonVisible()) {
        return;
      }
      await this.wait(500);
    }

    throw new Error('Timeout waiting for deploy button');
  }

  /**
   * Extract deployment info from the final response
   * Parses server ID, endpoint URL from response content
   */
  async getDeploymentInfo(): Promise<DeploymentInfo | null> {
    try {
      const response = await this.getLastAssistantMessage();

      // Parse server ID from response (e.g., "Server ID: mcp-abc123")
      const serverIdMatch = response.match(/server\s*id[:\s]+([a-z0-9-]+)/i);

      // Parse endpoint from response (e.g., "Endpoint: https://mcp-abc123.mcp.localhost")
      const endpointMatch = response.match(
        /(https?:\/\/[a-z0-9.-]+\.mcp\.localhost[^\s]*)/i
      );

      // Also check deployment result card
      let status = 'unknown';
      if (await this.deploymentResultCard.isVisible()) {
        status = 'deployed';
      } else if (await this.deploymentErrorCard.isVisible()) {
        status = 'failed';
      }

      if (serverIdMatch || endpointMatch) {
        return {
          serverId: serverIdMatch?.[1] || '',
          endpoint: endpointMatch?.[1] || '',
          status,
        };
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Get all progress messages currently displayed
   */
  async getAllProgressMessages(): Promise<string[]> {
    const messages: string[] = [];
    const count = await this.progressMessages.count();

    for (let i = 0; i < count; i++) {
      const text = await this.getText(
        this.progressMessages.nth(i).locator('.message-body')
      );
      if (text) {
        messages.push(text);
      }
    }

    return messages;
  }

  /**
   * Get the current phase (latest progress message)
   */
  async getCurrentPhase(): Promise<string | null> {
    try {
      const count = await this.progressMessages.count();
      if (count === 0) return null;

      // Get the last progress message
      const text = await this.getText(
        this.progressMessages.last().locator('.message-body')
      );
      return text || null;
    } catch {
      return null;
    }
  }

  /**
   * Check if generation is in progress (has active progress message)
   */
  async isGenerationInProgress(): Promise<boolean> {
    const hasProgress = await this.progressMessages.first().isVisible().catch(() => false);
    const isLoading = await this.isLoading();
    return hasProgress || isLoading;
  }

  /**
   * Check if generation completed successfully
   */
  async didGenerationSucceed(): Promise<boolean> {
    // Check for assistant message (non-progress, non-error)
    const assistantCount = await this.assistantMessages.count();
    if (assistantCount === 0) return false;

    // Verify not still loading
    const isLoading = await this.isLoading();
    if (isLoading) return false;

    // Check for download button or deployment actions as success indicators
    const hasDownload = await this.isDownloadButtonVisible();
    const hasDeployActions = await this.deploymentActions.isVisible().catch(() => false);

    return hasDownload || hasDeployActions;
  }

  /**
   * Check if generation failed (error message visible)
   */
  async didGenerationFail(): Promise<boolean> {
    return this.errorMessages.first().isVisible().catch(() => false);
  }

  /**
   * Get error message if generation failed
   */
  async getGenerationError(): Promise<string | null> {
    try {
      if (await this.didGenerationFail()) {
        return this.getText(this.errorMessages.first().locator('.message-body'));
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Wait for loading state to clear with extended timeout
   */
  async waitForLoadingCompleteE2E(
    timeout: number = ChatE2EPage.GENERATION_TIMEOUT
  ): Promise<void> {
    const startTime = Date.now();

    while (await this.isLoading()) {
      if (Date.now() - startTime > timeout) {
        throw new Error('Timeout waiting for loading to complete');
      }
      await this.wait(500);
    }
  }

  /**
   * Extract phase name from progress message
   * @private
   */
  private extractPhaseName(message: string): string {
    // Try to extract phase name from common patterns
    // e.g., "Analyzing repository..." -> "Analyzing"
    // e.g., "[Research] Fetching data..." -> "Research"
    const bracketMatch = message.match(/\[([^\]]+)\]/);
    if (bracketMatch) {
      return bracketMatch[1];
    }

    // Extract first word or phrase before "..."
    const ellipsisMatch = message.match(/^([^.]+?)\.{3}/);
    if (ellipsisMatch) {
      return ellipsisMatch[1].trim();
    }

    // Extract first word
    const firstWord = message.split(/\s+/)[0];
    return firstWord || 'Unknown';
  }
}
