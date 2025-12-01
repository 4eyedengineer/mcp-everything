import { test, expect } from '@playwright/test';
import { ChatPage } from '../page-objects/chat.page';
import { SidebarPage } from '../page-objects/sidebar.page';
import { MockBackend } from '../fixtures/mock-backend';
import { TEST_MESSAGES, TIMEOUTS } from '../fixtures/test-data';

test.describe('Chat Component', () => {
  let chatPage: ChatPage;
  let sidebarPage: SidebarPage;
  let mockBackend: MockBackend;

  test.beforeEach(async ({ page }) => {
    chatPage = new ChatPage(page);
    sidebarPage = new SidebarPage(page);
    mockBackend = new MockBackend(page);

    await chatPage.navigate();
  });

  test.describe('Welcome Screen', () => {
    test('should display welcome screen on first visit', async () => {
      await expect(chatPage.welcomeScreen).toBeVisible();
      await expect(chatPage.greeting).toBeVisible();

      const greeting = await chatPage.getGreeting();
      expect(greeting).toMatch(/Good (morning|afternoon|evening)/);
    });

    test('should display suggestion cards', async () => {
      const suggestions = await chatPage.getSuggestions();
      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions[0]).toBeTruthy();
    });

    test('should send message when clicking suggestion card', async ({ page }) => {
      // Mock backend
      await mockBackend.mockHappyPath();

      // Click first suggestion
      await chatPage.clickSuggestion(0);

      // Welcome screen should disappear
      await chatPage.waitForWelcomeScreenHidden();

      // User message should appear
      await expect(chatPage.userMessages.first()).toBeVisible();
    });
  });

  test.describe('Message Input', () => {
    test('should type and send message', async () => {
      await mockBackend.mockHappyPath();

      await chatPage.sendMessage(TEST_MESSAGES.simple);

      // Verify user message appears
      await expect(chatPage.userMessages.first()).toBeVisible();
      const userMsg = await chatPage.getLastUserMessage();
      expect(userMsg).toBe(TEST_MESSAGES.simple);
    });

    test('should send message with Enter key', async () => {
      await mockBackend.mockHappyPath();

      await chatPage.sendMessageWithEnter(TEST_MESSAGES.simple);

      await expect(chatPage.userMessages.first()).toBeVisible();
    });

    test('should not send empty message', async () => {
      await chatPage.typeMessage(TEST_MESSAGES.empty);

      // Send button should be disabled
      const isDisabled = await chatPage.isSendButtonDisabled();
      expect(isDisabled).toBe(true);

      await chatPage.clickSend();

      // No messages should appear
      const messageCount = await chatPage.getMessageCount();
      expect(messageCount).toBe(0);
    });

    test('should not send whitespace-only message', async () => {
      await chatPage.typeMessage(TEST_MESSAGES.whitespace);

      const isDisabled = await chatPage.isSendButtonDisabled();
      expect(isDisabled).toBe(true);
    });

    test('should clear input after sending message', async () => {
      await mockBackend.mockHappyPath();

      await chatPage.sendMessage(TEST_MESSAGES.simple);

      // Input should be cleared
      const inputValue = await chatPage.getMessageInputValue();
      expect(inputValue).toBe('');
    });

    test('should auto-resize textarea with multiline content', async () => {
      const initialHeight = await chatPage.getMessageInputHeight();

      await chatPage.typeMessage(TEST_MESSAGES.multiline);

      const newHeight = await chatPage.getMessageInputHeight();
      expect(newHeight).toBeGreaterThan(initialHeight);
    });

    test('should handle very long messages', async () => {
      await mockBackend.mockHappyPath();

      await chatPage.sendMessage(TEST_MESSAGES.veryLong);

      await expect(chatPage.userMessages.first()).toBeVisible();
      const userMsg = await chatPage.getLastUserMessage();
      expect(userMsg).toBe(TEST_MESSAGES.veryLong);
    });

    test('should handle unicode and emojis', async () => {
      await mockBackend.mockHappyPath();

      await chatPage.sendMessage(TEST_MESSAGES.unicode);

      await expect(chatPage.userMessages.first()).toBeVisible();
      const userMsg = await chatPage.getLastUserMessage();
      expect(userMsg).toContain('🚀');
      expect(userMsg).toContain('👨‍💻');
    });
  });

  test.describe('Loading State', () => {
    test('should show loading indicator while processing', async ({ page }) => {
      await mockBackend.mockChatMessage();
      // Don't mock SSE to simulate pending state
      await mockBackend.mockSSEStream([]);

      await chatPage.sendMessage(TEST_MESSAGES.simple);

      // Loading state should be active
      const isLoading = await chatPage.isLoading();
      expect(isLoading).toBe(true);

      // Send button should be disabled
      const isDisabled = await chatPage.isSendButtonDisabled();
      expect(isDisabled).toBe(true);
    });

    test('should prevent sending multiple messages while loading', async () => {
      await mockBackend.mockChatMessage();
      await mockBackend.mockSSEStream([]);

      // Send first message
      await chatPage.sendMessage(TEST_MESSAGES.simple);

      // Try to send second message while loading
      await chatPage.typeMessage('Second message');
      await chatPage.messageInput.press('Enter');

      // Only one user message should exist
      const userMessageCount = await chatPage.getUserMessageCount();
      expect(userMessageCount).toBe(1);
    });
  });

  test.describe('Keyboard Navigation', () => {
    test('should focus input with Tab key', async ({ page }) => {
      await page.keyboard.press('Tab');

      const isFocused = await chatPage.isMessageInputFocused();
      expect(isFocused).toBe(true);
    });

    test('should submit with Enter and add newline with Shift+Enter', async () => {
      await mockBackend.mockHappyPath();

      // Shift+Enter should add newline
      await chatPage.messageInput.focus();
      await chatPage.messageInput.type('Line 1');
      await chatPage.page.keyboard.press('Shift+Enter');
      await chatPage.messageInput.type('Line 2');

      const value = await chatPage.getMessageInputValue();
      expect(value).toContain('\n');

      // Enter should submit
      await chatPage.messageInput.press('Enter');
      await expect(chatPage.userMessages.first()).toBeVisible();
    });
  });

  test.describe('Message Display', () => {
    test('should display messages in correct order', async () => {
      await mockBackend.mockHappyPath();

      await chatPage.sendMessage(TEST_MESSAGES.simple);

      // Wait for user and assistant messages
      await chatPage.waitForUserMessage();
      await chatPage.waitForAssistantResponse();

      const messages = await chatPage.getAllMessages();
      expect(messages.length).toBeGreaterThanOrEqual(2);
      expect(messages[0].type).toBe('user');
      expect(messages[messages.length - 1].type).toBe('assistant');
    });

    test('should scroll to bottom when new message arrives', async () => {
      await mockBackend.mockHappyPath();

      await chatPage.sendMessage(TEST_MESSAGES.simple);
      await chatPage.waitForAssistantResponse();

      // Last message should be in viewport
      const messageCount = await chatPage.getMessageCount();
      const lastMessageVisible = await chatPage.isMessageInViewport(messageCount - 1);
      expect(lastMessageVisible).toBe(true);
    });
  });

  test.describe('Error Handling', () => {
    test('should display error message when backend fails', async ({ page }) => {
      await mockBackend.mockServerError('**/api/chat/message');

      await chatPage.sendMessage(TEST_MESSAGES.simple);

      // Error notification should appear
      await expect(page.locator('.mat-mdc-snack-bar-container')).toBeVisible({ timeout: 5000 });
    });

    test('should handle network errors gracefully', async ({ page }) => {
      await mockBackend.mockNetworkError('**/api/chat/message');

      await chatPage.sendMessage(TEST_MESSAGES.simple);

      // Error notification should appear
      await expect(page.locator('.mat-mdc-snack-bar-container')).toBeVisible({ timeout: 5000 });
    });
  });
});
