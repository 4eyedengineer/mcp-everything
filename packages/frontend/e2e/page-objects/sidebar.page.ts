import { Page, Locator } from '@playwright/test';
import { BasePage } from './base.page';

export interface Conversation {
  id: string;
  title: string;
  timestamp: string;
}

/**
 * Page Object for the Conversation Sidebar Component
 */
export class SidebarPage extends BasePage {
  // Locators
  readonly sidebar: Locator;
  readonly hamburgerButton: Locator;
  readonly closeButton: Locator;
  readonly newChatButton: Locator;
  readonly conversationItems: Locator;
  readonly settingsButton: Locator;
  readonly overlay: Locator;
  readonly emptyState: Locator;

  constructor(page: Page) {
    super(page);

    this.sidebar = page.locator('.conversation-sidebar');
    this.hamburgerButton = page.locator('.hamburger-button');
    this.closeButton = page.locator('.close-button');
    this.newChatButton = page.locator('.new-chat-button');
    this.conversationItems = page.locator('.conversation-item');
    this.settingsButton = page.locator('.footer-button').filter({ hasText: 'Settings' });
    this.overlay = page.locator('.sidebar-overlay');
    this.emptyState = page.locator('.empty-state');
  }

  /**
   * Check if sidebar is open
   */
  async isOpen(): Promise<boolean> {
    const classes = await this.sidebar.getAttribute('class');
    return classes?.includes('open') || false;
  }

  /**
   * Check if sidebar is closed
   */
  async isClosed(): Promise<boolean> {
    return !(await this.isOpen());
  }

  /**
   * Open sidebar by clicking hamburger button
   */
  async open(): Promise<void> {
    if (await this.isClosed()) {
      await this.hamburgerButton.click();
      await this.waitForVisible(this.sidebar);
    }
  }

  /**
   * Close sidebar by clicking close button
   */
  async close(): Promise<void> {
    if (await this.isOpen()) {
      await this.closeButton.click();
      await this.waitForHidden(this.sidebar);
    }
  }

  /**
   * Toggle sidebar open/closed
   */
  async toggle(): Promise<void> {
    await this.hamburgerButton.click();
  }

  /**
   * Close sidebar by clicking overlay
   */
  async closeByOverlay(): Promise<void> {
    if (await this.isOpen()) {
      await this.overlay.click();
      await this.waitForHidden(this.sidebar);
    }
  }

  /**
   * Click new chat button
   */
  async createNewChat(): Promise<void> {
    await this.newChatButton.click();
  }

  /**
   * Get count of conversations
   */
  async getConversationCount(): Promise<number> {
    return this.conversationItems.count();
  }

  /**
   * Check if empty state is visible
   */
  async isEmptyStateVisible(): Promise<boolean> {
    return this.emptyState.isVisible();
  }

  /**
   * Get all conversation titles
   */
  async getConversationTitles(): Promise<string[]> {
    const items = await this.conversationItems.all();
    const titles: string[] = [];
    for (const item of items) {
      const title = await this.getText(item.locator('.conversation-title'));
      titles.push(title);
    }
    return titles;
  }

  /**
   * Get all conversation timestamps
   */
  async getConversationTimestamps(): Promise<string[]> {
    const items = await this.conversationItems.all();
    const timestamps: string[] = [];
    for (const item of items) {
      const timestamp = await this.getText(item.locator('.conversation-time'));
      timestamps.push(timestamp);
    }
    return timestamps;
  }

  /**
   * Click a conversation by index (0-based)
   */
  async selectConversation(index: number): Promise<void> {
    await this.conversationItems.nth(index).click();
  }

  /**
   * Click a conversation by title
   */
  async selectConversationByTitle(title: string): Promise<void> {
    await this.conversationItems.filter({ hasText: title }).first().click();
  }

  /**
   * Get the first conversation title
   */
  async getFirstConversationTitle(): Promise<string> {
    return this.getText(this.conversationItems.first().locator('.conversation-title'));
  }

  /**
   * Get the last conversation title
   */
  async getLastConversationTitle(): Promise<string> {
    return this.getText(this.conversationItems.last().locator('.conversation-title'));
  }

  /**
   * Click settings button
   */
  async navigateToSettings(): Promise<void> {
    await this.settingsButton.click();
  }

  /**
   * Check if new chat button is visible
   */
  async isNewChatButtonVisible(): Promise<boolean> {
    return this.newChatButton.isVisible();
  }

  /**
   * Check if settings button is visible
   */
  async isSettingsButtonVisible(): Promise<boolean> {
    return this.settingsButton.isVisible();
  }

  /**
   * Wait for conversations to load
   */
  async waitForConversations(timeout = 10000): Promise<void> {
    await this.conversationItems.first().waitFor({ state: 'visible', timeout });
  }

  /**
   * Wait for sidebar animation to complete
   */
  async waitForAnimation(): Promise<void> {
    await this.wait(300); // Sidebar animation duration
  }

  /**
   * Get conversation item by index
   */
  getConversationItem(index: number): Locator {
    return this.conversationItems.nth(index);
  }

  /**
   * Check if conversation has a menu button
   */
  async hasMenuButton(index: number): Promise<boolean> {
    const menuButton = this.conversationItems.nth(index).locator('.conversation-menu');
    return menuButton.isVisible();
  }

  /**
   * Click conversation menu button (if implemented)
   */
  async openConversationMenu(index: number): Promise<void> {
    const menuButton = this.conversationItems.nth(index).locator('.conversation-menu');
    await menuButton.click();
  }
}
