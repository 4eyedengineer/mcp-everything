import { Page, Locator, expect } from '@playwright/test';
import { BasePage } from './base.page';

export interface ChatMessage {
  content: string;
  isUser: boolean;
  timestamp: Date;
  type: 'user' | 'assistant' | 'progress' | 'error';
}

/**
 * Page Object for the Chat Component
 * Handles all interactions with the main chat interface
 */
export class ChatPage extends BasePage {
  // Locators
  readonly messageInput: Locator;
  readonly sendButton: Locator;
  readonly attachButton: Locator;
  readonly welcomeScreen: Locator;
  readonly greeting: Locator;
  readonly suggestionCards: Locator;
  readonly messagesArea: Locator;
  readonly messageWrappers: Locator;
  readonly userMessages: Locator;
  readonly assistantMessages: Locator;
  readonly progressMessages: Locator;
  readonly errorMessages: Locator;
  readonly downloadButton: Locator;
  readonly loadingIndicator: Locator;

  constructor(page: Page) {
    super(page);

    // Initialize locators
    this.messageInput = page.locator('.message-input');
    this.sendButton = page.locator('.send-button');
    this.attachButton = page.locator('.input-icon-button').filter({ hasText: 'attach_file' });
    this.welcomeScreen = page.locator('.welcome-screen');
    this.greeting = page.locator('.greeting');
    this.suggestionCards = page.locator('.suggestion-card');
    this.messagesArea = page.locator('.messages-area');
    this.messageWrappers = page.locator('.message-wrapper');
    this.userMessages = page.locator('.user-message');
    this.assistantMessages = page.locator('.assistant-message');
    this.progressMessages = page.locator('.progress-message');
    this.errorMessages = page.locator('.error-message');
    this.downloadButton = page.locator('.download-button');
    this.loadingIndicator = page.locator('mat-spinner');
  }

  /**
   * Navigate to chat page
   */
  async navigate(): Promise<void> {
    await this.goto('/chat');
  }

  /**
   * Navigate to specific conversation
   */
  async navigateToConversation(conversationId: string): Promise<void> {
    await this.goto(`/chat/${conversationId}`);
  }

  /**
   * Check if welcome screen is visible
   */
  async isWelcomeScreenVisible(): Promise<boolean> {
    return this.welcomeScreen.isVisible();
  }

  /**
   * Get greeting text (should be "Good morning/afternoon/evening")
   */
  async getGreeting(): Promise<string> {
    return this.getText(this.greeting);
  }

  /**
   * Get all suggestion card texts
   */
  async getSuggestions(): Promise<string[]> {
    const cards = await this.suggestionCards.all();
    return Promise.all(cards.map(card => this.getText(card)));
  }

  /**
   * Click a suggestion card by index (0-based)
   */
  async clickSuggestion(index: number): Promise<void> {
    await this.suggestionCards.nth(index).click();
  }

  /**
   * Click a suggestion card by text content
   */
  async clickSuggestionByText(text: string): Promise<void> {
    await this.suggestionCards.filter({ hasText: text }).first().click();
  }

  /**
   * Type a message in the input field
   */
  async typeMessage(message: string): Promise<void> {
    await this.messageInput.fill(message);
  }

  /**
   * Clear the message input
   */
  async clearMessage(): Promise<void> {
    await this.messageInput.clear();
  }

  /**
   * Get current message input value
   */
  async getMessageInputValue(): Promise<string> {
    return (await this.messageInput.inputValue()) || '';
  }

  /**
   * Click the send button
   */
  async clickSend(): Promise<void> {
    await this.sendButton.click();
  }

  /**
   * Send a message (type and click send)
   */
  async sendMessage(message: string): Promise<void> {
    await this.typeMessage(message);
    await this.clickSend();
  }

  /**
   * Send a message with Enter key
   */
  async sendMessageWithEnter(message: string): Promise<void> {
    await this.typeMessage(message);
    await this.messageInput.press('Enter');
  }

  /**
   * Check if send button is disabled
   */
  async isSendButtonDisabled(): Promise<boolean> {
    return this.sendButton.isDisabled();
  }

  /**
   * Check if currently loading (send button shows progress)
   */
  async isLoading(): Promise<boolean> {
    const icon = await this.sendButton.locator('mat-icon').textContent();
    return icon === 'hourglass_empty';
  }

  /**
   * Get count of all messages
   */
  async getMessageCount(): Promise<number> {
    return this.messageWrappers.count();
  }

  /**
   * Get count of user messages
   */
  async getUserMessageCount(): Promise<number> {
    return this.userMessages.count();
  }

  /**
   * Get count of assistant messages
   */
  async getAssistantMessageCount(): Promise<number> {
    return this.assistantMessages.count();
  }

  /**
   * Get count of progress messages
   */
  async getProgressMessageCount(): Promise<number> {
    return this.progressMessages.count();
  }

  /**
   * Get the last user message text
   */
  async getLastUserMessage(): Promise<string> {
    return this.getText(this.userMessages.last().locator('.message-body'));
  }

  /**
   * Get the last assistant message text
   */
  async getLastAssistantMessage(): Promise<string> {
    return this.getText(this.assistantMessages.last().locator('.message-body'));
  }

  /**
   * Get current progress message text
   */
  async getProgressMessage(): Promise<string> {
    return this.getText(this.progressMessages.first().locator('.message-body'));
  }

  /**
   * Wait for user message to appear
   */
  async waitForUserMessage(timeout = 5000): Promise<void> {
    await this.userMessages.first().waitFor({ state: 'visible', timeout });
  }

  /**
   * Wait for assistant response
   */
  async waitForAssistantResponse(timeout = 30000): Promise<void> {
    await this.assistantMessages.first().waitFor({ state: 'visible', timeout });
  }

  /**
   * Wait for progress message
   */
  async waitForProgressMessage(timeout = 10000): Promise<void> {
    await this.progressMessages.first().waitFor({ state: 'visible', timeout });
  }

  /**
   * Wait for download button to appear
   */
  async waitForDownloadButton(timeout = 30000): Promise<void> {
    await this.downloadButton.waitFor({ state: 'visible', timeout });
  }

  /**
   * Click download button and wait for download
   */
  async downloadGeneratedCode(): Promise<string> {
    const downloadPromise = this.page.waitForEvent('download');
    await this.downloadButton.click();
    const download = await downloadPromise;
    const path = await download.path();
    return path || '';
  }

  /**
   * Get download button text (contains timestamp)
   */
  async getDownloadButtonText(): Promise<string> {
    return this.getText(this.downloadButton);
  }

  /**
   * Check if download button is visible
   */
  async isDownloadButtonVisible(): Promise<boolean> {
    return this.downloadButton.isVisible();
  }

  /**
   * Wait for loading to complete
   */
  async waitForLoadingComplete(timeout = 30000): Promise<void> {
    const startTime = Date.now();
    while (await this.isLoading()) {
      if (Date.now() - startTime > timeout) {
        throw new Error('Timeout waiting for loading to complete');
      }
      await this.wait(500);
    }
  }

  /**
   * Get message input height (for auto-resize testing)
   */
  async getMessageInputHeight(): Promise<number> {
    return this.messageInput.evaluate(el => el.offsetHeight);
  }

  /**
   * Check if message input has focus
   */
  async isMessageInputFocused(): Promise<boolean> {
    return this.messageInput.evaluate(el => el === document.activeElement);
  }

  /**
   * Get all message texts in order
   */
  async getAllMessages(): Promise<Array<{ type: string; content: string }>> {
    const wrappers = await this.messageWrappers.all();
    const messages: Array<{ type: string; content: string }> = [];

    for (const wrapper of wrappers) {
      const classList = await wrapper.getAttribute('class');
      let type = 'unknown';
      if (classList?.includes('user-message')) type = 'user';
      else if (classList?.includes('assistant-message')) type = 'assistant';
      else if (classList?.includes('progress-message')) type = 'progress';
      else if (classList?.includes('error-message')) type = 'error';

      const content = await this.getText(wrapper.locator('.message-body'));
      messages.push({ type, content });
    }

    return messages;
  }

  /**
   * Get conversation ID from URL
   */
  getConversationIdFromUrl(): string | null {
    const match = this.getUrl().match(/\/chat\/([a-f0-9-]+)/);
    return match ? match[1] : null;
  }

  /**
   * Check if on chat page (with or without conversation ID)
   */
  isOnChatPage(): boolean {
    return this.getUrl().includes('/chat');
  }

  /**
   * Scroll messages to bottom
   */
  async scrollToBottom(): Promise<void> {
    await this.messagesArea.evaluate(el => el.scrollTo(0, el.scrollHeight));
  }

  /**
   * Scroll messages to top
   */
  async scrollToTop(): Promise<void> {
    await this.messagesArea.evaluate(el => el.scrollTo(0, 0));
  }

  /**
   * Check if a message is in viewport
   */
  async isMessageInViewport(index: number): Promise<boolean> {
    return this.messageWrappers.nth(index).isInViewport();
  }

  /**
   * Wait for welcome screen to disappear
   */
  async waitForWelcomeScreenHidden(timeout = 5000): Promise<void> {
    await this.welcomeScreen.waitFor({ state: 'hidden', timeout });
  }

  /**
   * Check if error message is visible
   */
  async isErrorMessageVisible(): Promise<boolean> {
    return this.errorMessages.first().isVisible();
  }

  /**
   * Get error message text
   */
  async getErrorMessage(): Promise<string> {
    return this.getText(this.errorMessages.first().locator('.message-body'));
  }

  // ==========================================
  // Core Features / Generation-specific methods
  // ==========================================

  /**
   * Download ZIP button locator (specific to generated code)
   */
  get downloadZipButton(): Locator {
    return this.page.locator('.download-zip-button');
  }

  /**
   * Check if download ZIP button is visible
   */
  async hasDownloadZipButton(): Promise<boolean> {
    return this.downloadZipButton.isVisible();
  }

  /**
   * Click download ZIP button and wait for download
   * Returns the path to the downloaded file
   */
  async clickDownloadZip(): Promise<string> {
    const downloadPromise = this.page.waitForEvent('download');
    await this.downloadZipButton.click();
    const download = await downloadPromise;
    const path = await download.path();
    return path || '';
  }

  /**
   * Wait for generation to complete (download ZIP button appears)
   * This indicates the LangGraph pipeline has finished successfully
   */
  async waitForGenerationComplete(timeout = 300000): Promise<void> {
    await this.downloadZipButton.waitFor({ state: 'visible', timeout });
  }

  /**
   * Wait for a specific progress phase to appear
   * Useful for tracking LangGraph node execution
   *
   * @param phase - Text to search for in progress messages (e.g., "Analyzing", "Research", "Ensemble")
   * @param timeout - Maximum time to wait
   */
  async waitForProgressPhase(phase: string, timeout = 60000): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const progressCount = await this.getProgressMessageCount();
      if (progressCount > 0) {
        const progressText = await this.getProgressMessage();
        if (progressText.toLowerCase().includes(phase.toLowerCase())) {
          return;
        }
      }
      await this.wait(500);
    }

    throw new Error(`Progress phase "${phase}" not found within ${timeout}ms`);
  }

  /**
   * Get all progress messages that have appeared
   */
  async getAllProgressMessages(): Promise<string[]> {
    const progressElements = await this.progressMessages.all();
    const messages: string[] = [];

    for (const element of progressElements) {
      const text = await this.getText(element.locator('.message-body'));
      messages.push(text);
    }

    return messages;
  }

  /**
   * Check if progress message contains spinning icon (autorenew)
   */
  async hasProgressSpinner(): Promise<boolean> {
    const progressMessage = this.progressMessages.first();
    if (!(await progressMessage.isVisible())) {
      return false;
    }
    const icon = progressMessage.locator('mat-icon');
    const iconText = await icon.textContent();
    return iconText === 'autorenew';
  }

  /**
   * Wait for assistant response that contains specific text
   */
  async waitForAssistantResponseContaining(
    text: string,
    timeout = 30000
  ): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const assistantCount = await this.getAssistantMessageCount();
      if (assistantCount > 0) {
        const messages = await this.getAllMessages();
        const assistantMessages = messages.filter((m) => m.type === 'assistant');
        if (assistantMessages.some((m) => m.content.toLowerCase().includes(text.toLowerCase()))) {
          return;
        }
      }
      await this.wait(500);
    }

    throw new Error(`Assistant response containing "${text}" not found within ${timeout}ms`);
  }

  /**
   * Check if a clarification question is being asked
   * (indicated by the AI asking for more information)
   */
  async isClarificationBeingAsked(): Promise<boolean> {
    const assistantCount = await this.getAssistantMessageCount();
    if (assistantCount === 0) return false;

    const lastMessage = await this.getLastAssistantMessage();
    const clarificationIndicators = [
      'could you',
      'can you',
      'please provide',
      'what',
      'which',
      'how',
      'clarify',
      'more information',
      'specify',
      '?',
    ];

    const lowerMessage = lastMessage.toLowerCase();
    return clarificationIndicators.some((indicator) => lowerMessage.includes(indicator));
  }

  /**
   * Get session ID from localStorage
   */
  async getSessionId(): Promise<string | null> {
    return this.page.evaluate(() => {
      return localStorage.getItem('sessionId');
    });
  }

  /**
   * Wait for any new message to appear after current count
   */
  async waitForNewMessage(currentCount: number, timeout = 30000): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const newCount = await this.getMessageCount();
      if (newCount > currentCount) {
        return;
      }
      await this.wait(500);
    }

    throw new Error(`No new message appeared within ${timeout}ms`);
  }
}
