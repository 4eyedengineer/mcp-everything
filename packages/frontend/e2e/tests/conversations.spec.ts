import { test, expect } from '@playwright/test';
import { ChatPage } from '../page-objects/chat.page';
import { SidebarPage } from '../page-objects/sidebar.page';
import { MockBackend } from '../fixtures/mock-backend';
import { TEST_MESSAGES, MOCK_CONVERSATIONS, TIMEOUTS } from '../fixtures/test-data';

test.describe('Conversation Management', () => {
  let chatPage: ChatPage;
  let sidebarPage: SidebarPage;
  let mockBackend: MockBackend;

  test.beforeEach(async ({ page }) => {
    chatPage = new ChatPage(page);
    sidebarPage = new SidebarPage(page);
    mockBackend = new MockBackend(page);
  });

  test.describe('Conversation Creation', () => {
    test('should create new conversation when sending first message', async ({ page }) => {
      await chatPage.navigate();
      await mockBackend.mockHappyPath();

      // Initially no conversation ID in URL
      expect(chatPage.getConversationIdFromUrl()).toBeNull();

      await chatPage.sendMessage(TEST_MESSAGES.simple);

      // Wait for navigation to conversation URL
      await page.waitForURL(/\/chat\/[a-f0-9-]+/, { timeout: TIMEOUTS.medium });

      // Conversation ID should now be in URL
      const conversationId = chatPage.getConversationIdFromUrl();
      expect(conversationId).toBeTruthy();
      expect(conversationId).toMatch(/^[a-f0-9-]+$/);
    });

    test('should create new conversation from sidebar button', async ({ page }) => {
      await chatPage.navigate();
      await mockBackend.mockConversationCreate();

      // Open sidebar and click new chat
      await sidebarPage.open();
      await sidebarPage.createNewChat();

      // Should navigate to new conversation
      await page.waitForURL(/\/chat\/[a-f0-9-]+/);

      // Welcome screen should be visible
      await expect(chatPage.welcomeScreen).toBeVisible();

      // No messages should be present
      const messageCount = await chatPage.getMessageCount();
      expect(messageCount).toBe(0);
    });

    test('should generate unique conversation IDs', async ({ page }) => {
      await mockBackend.mockHappyPath();

      // Create first conversation
      await chatPage.navigate();
      await chatPage.sendMessage('First conversation');
      await page.waitForURL(/\/chat\/[a-f0-9-]+/);
      const firstId = chatPage.getConversationIdFromUrl();

      // Create second conversation
      await sidebarPage.open();
      await sidebarPage.createNewChat();
      await chatPage.sendMessage('Second conversation');
      await page.waitForURL(/\/chat\/[a-f0-9-]+/);
      const secondId = chatPage.getConversationIdFromUrl();

      // IDs should be different
      expect(firstId).not.toBe(secondId);
    });
  });

  test.describe('Conversation History', () => {
    test('should load conversation history when navigating to conversation', async () => {
      const conversationId = MOCK_CONVERSATIONS[0].id;
      await mockBackend.mockConversationMessages(conversationId);

      await chatPage.navigateToConversation(conversationId);

      // Wait for messages to load
      await chatPage.waitForUserMessage(TIMEOUTS.medium);

      // Messages should be visible
      const messageCount = await chatPage.getMessageCount();
      expect(messageCount).toBeGreaterThan(0);
    });

    test('should display correct messages for conversation', async () => {
      const conversationId = MOCK_CONVERSATIONS[0].id;
      await mockBackend.mockConversationMessages(conversationId);

      await chatPage.navigateToConversation(conversationId);
      await chatPage.waitForUserMessage();

      const messages = await chatPage.getAllMessages();
      expect(messages.length).toBeGreaterThan(0);

      // First message should be user message
      expect(messages[0].type).toBe('user');
    });

    test('should clear messages when navigating to new chat', async ({ page }) => {
      const conversationId = MOCK_CONVERSATIONS[0].id;
      await mockBackend.mockConversationMessages(conversationId);

      // Load conversation with history
      await chatPage.navigateToConversation(conversationId);
      await chatPage.waitForUserMessage();

      const historyCount = await chatPage.getMessageCount();
      expect(historyCount).toBeGreaterThan(0);

      // Navigate to new chat
      await chatPage.navigate();

      // Messages should be cleared
      const newCount = await chatPage.getMessageCount();
      expect(newCount).toBe(0);

      // Welcome screen should be visible
      await expect(chatPage.welcomeScreen).toBeVisible();
    });

    test('should preserve conversation history on page reload', async ({ page }) => {
      const conversationId = MOCK_CONVERSATIONS[0].id;
      await mockBackend.mockConversationMessages(conversationId);

      await chatPage.navigateToConversation(conversationId);
      await chatPage.waitForUserMessage();

      const messagesBefore = await chatPage.getAllMessages();

      // Reload page
      await page.reload();
      await chatPage.waitForUserMessage();

      const messagesAfter = await chatPage.getAllMessages();

      // Same messages should be present
      expect(messagesAfter.length).toBe(messagesBefore.length);
    });
  });

  test.describe('Conversation Switching', () => {
    test('should switch between conversations from sidebar', async ({ page }) => {
      await mockBackend.mockConversationsList();
      await mockBackend.mockConversationMessages('*');

      await chatPage.navigate();
      await sidebarPage.open();
      await sidebarPage.waitForConversations();

      // Click first conversation
      await sidebarPage.selectConversation(0);
      await page.waitForURL(/\/chat\/[a-f0-9-]+/);
      const firstId = chatPage.getConversationIdFromUrl();

      // Clear sidebar to prepare for next selection
      await sidebarPage.open();

      // Click second conversation
      await sidebarPage.selectConversation(1);
      await page.waitForURL(/\/chat\/[a-f0-9-]+/);
      const secondId = chatPage.getConversationIdFromUrl();

      // Should navigate to different conversation
      expect(firstId).not.toBe(secondId);
    });

    test('should load correct history when switching conversations', async ({ page }) => {
      await mockBackend.mockConversationsList(MOCK_CONVERSATIONS);

      // Mock different messages for each conversation
      await mockBackend.mockConversationMessages(MOCK_CONVERSATIONS[0].id, [
        {
          id: 'msg-1',
          conversationId: MOCK_CONVERSATIONS[0].id,
          content: 'Message from conversation 1',
          role: 'user' as const,
          timestamp: new Date(),
        },
      ]);

      await mockBackend.mockConversationMessages(MOCK_CONVERSATIONS[1].id, [
        {
          id: 'msg-2',
          conversationId: MOCK_CONVERSATIONS[1].id,
          content: 'Message from conversation 2',
          role: 'user' as const,
          timestamp: new Date(),
        },
      ]);

      await chatPage.navigate();
      await sidebarPage.open();
      await sidebarPage.waitForConversations();

      // Select first conversation
      await sidebarPage.selectConversation(0);
      await chatPage.waitForUserMessage();
      const firstMessage = await chatPage.getLastUserMessage();

      // Select second conversation
      await sidebarPage.open();
      await sidebarPage.selectConversation(1);
      await chatPage.waitForUserMessage();
      const secondMessage = await chatPage.getLastUserMessage();

      // Messages should be different
      expect(firstMessage).not.toBe(secondMessage);
    });
  });

  test.describe('Conversation List', () => {
    test('should display conversations in sidebar', async () => {
      await mockBackend.mockConversationsList();

      await chatPage.navigate();
      await sidebarPage.open();
      await sidebarPage.waitForConversations();

      const count = await sidebarPage.getConversationCount();
      expect(count).toBeGreaterThan(0);
    });

    test('should show conversation titles', async () => {
      await mockBackend.mockConversationsList(MOCK_CONVERSATIONS);

      await chatPage.navigate();
      await sidebarPage.open();
      await sidebarPage.waitForConversations();

      const titles = await sidebarPage.getConversationTitles();
      expect(titles.length).toBe(MOCK_CONVERSATIONS.length);
      expect(titles[0]).toBeTruthy();
    });

    test('should show relative timestamps', async () => {
      await mockBackend.mockConversationsList(MOCK_CONVERSATIONS);

      await chatPage.navigate();
      await sidebarPage.open();
      await sidebarPage.waitForConversations();

      const timestamps = await sidebarPage.getConversationTimestamps();
      expect(timestamps.length).toBe(MOCK_CONVERSATIONS.length);

      // Should show relative time (e.g., "5 minutes ago", "1 hour ago")
      expect(timestamps[0]).toBeTruthy();
    });

    test('should show empty state when no conversations', async () => {
      await mockBackend.mockConversationsList([]);

      await chatPage.navigate();
      await sidebarPage.open();

      const isEmpty = await sidebarPage.isEmptyStateVisible();
      expect(isEmpty).toBe(true);
    });

    test('should sort conversations by most recent first', async () => {
      await mockBackend.mockConversationsList(MOCK_CONVERSATIONS);

      await chatPage.navigate();
      await sidebarPage.open();
      await sidebarPage.waitForConversations();

      const titles = await sidebarPage.getConversationTitles();

      // First conversation should be the most recently updated
      expect(titles[0]).toBe(MOCK_CONVERSATIONS[0].title);
    });
  });

  test.describe('Session Persistence', () => {
    test('should persist session ID across page reloads', async ({ page }) => {
      await chatPage.navigate();

      const sessionId1 = await chatPage.getSessionId();
      expect(sessionId1).toBeTruthy();

      await page.reload();

      const sessionId2 = await chatPage.getSessionId();
      expect(sessionId2).toBe(sessionId1);
    });

    test('should generate session ID on first visit', async () => {
      await chatPage.clearLocalStorage();
      await chatPage.navigate();

      const sessionId = await chatPage.getSessionId();
      expect(sessionId).toBeTruthy();
      expect(sessionId).toMatch(/^[a-f0-9-]+$/); // UUID format
    });

    test('should maintain conversation context within session', async ({ page }) => {
      await mockBackend.mockHappyPath();

      await chatPage.navigate();
      const sessionId = await chatPage.getSessionId();

      // Send first message
      await chatPage.sendMessage('First message');
      await page.waitForURL(/\/chat\/[a-f0-9-]+/);

      // Session ID should remain the same
      const sessionIdAfter = await chatPage.getSessionId();
      expect(sessionIdAfter).toBe(sessionId);
    });
  });

  test.describe('Browser Navigation', () => {
    test('should handle browser back button', async ({ page }) => {
      await mockBackend.mockConversationMessages('*');

      await chatPage.navigate();
      const originalUrl = page.url();

      // Navigate to a conversation
      await chatPage.navigateToConversation(MOCK_CONVERSATIONS[0].id);
      await chatPage.waitForUserMessage();

      // Go back
      await page.goBack();
      await page.waitForURL(originalUrl);

      // Should be back at main chat page
      expect(chatPage.getConversationIdFromUrl()).toBeNull();
    });

    test('should handle browser forward button', async ({ page }) => {
      await mockBackend.mockConversationMessages('*');

      await chatPage.navigate();

      // Navigate to conversation
      const conversationId = MOCK_CONVERSATIONS[0].id;
      await chatPage.navigateToConversation(conversationId);
      await chatPage.waitForUserMessage();
      const conversationUrl = page.url();

      // Go back
      await page.goBack();

      // Go forward
      await page.goForward();
      await page.waitForURL(conversationUrl);

      // Should be back at conversation
      expect(chatPage.getConversationIdFromUrl()).toBe(conversationId);
    });

    test('should support deep linking to conversations', async ({ page }) => {
      const conversationId = MOCK_CONVERSATIONS[0].id;
      await mockBackend.mockConversationMessages(conversationId);

      // Navigate directly to conversation URL
      await chatPage.navigateToConversation(conversationId);
      await chatPage.waitForUserMessage();

      // Conversation should load
      const messageCount = await chatPage.getMessageCount();
      expect(messageCount).toBeGreaterThan(0);

      // URL should contain conversation ID
      expect(page.url()).toContain(conversationId);
    });
  });
});
