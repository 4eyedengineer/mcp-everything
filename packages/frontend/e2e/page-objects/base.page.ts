import { Page, Locator, expect } from '@playwright/test';

/**
 * Base Page Object with common utilities for all page objects
 */
export class BasePage {
  constructor(protected page: Page) {}

  /**
   * Navigate to a path relative to base URL
   */
  async goto(path: string = '/'): Promise<void> {
    await this.page.goto(path);
  }

  /**
   * Wait for navigation to complete
   */
  async waitForNavigation(urlPattern?: RegExp): Promise<void> {
    if (urlPattern) {
      await this.page.waitForURL(urlPattern);
    } else {
      await this.page.waitForLoadState('networkidle');
    }
  }

  /**
   * Get current URL
   */
  getUrl(): string {
    return this.page.url();
  }

  /**
   * Get session ID from localStorage
   */
  async getSessionId(): Promise<string | null> {
    return this.page.evaluate(() => localStorage.getItem('mcp-session-id'));
  }

  /**
   * Set session ID in localStorage
   */
  async setSessionId(sessionId: string): Promise<void> {
    await this.page.evaluate(
      (id) => localStorage.setItem('mcp-session-id', id),
      sessionId
    );
  }

  /**
   * Clear all localStorage
   */
  async clearLocalStorage(): Promise<void> {
    await this.page.evaluate(() => localStorage.clear());
  }

  /**
   * Wait for Angular to be stable (no pending HTTP requests)
   */
  async waitForAngular(): Promise<void> {
    await this.page.waitForLoadState('networkidle');
  }

  /**
   * Take a screenshot with a descriptive name
   */
  async screenshot(name: string): Promise<void> {
    await this.page.screenshot({ path: `e2e/screenshots/${name}.png` });
  }

  /**
   * Wait for an element to be visible
   */
  async waitForVisible(locator: Locator, timeout = 10000): Promise<void> {
    await locator.waitFor({ state: 'visible', timeout });
  }

  /**
   * Wait for an element to be hidden
   */
  async waitForHidden(locator: Locator, timeout = 10000): Promise<void> {
    await locator.waitFor({ state: 'hidden', timeout });
  }

  /**
   * Get text content from an element
   */
  async getText(locator: Locator): Promise<string> {
    return (await locator.textContent()) || '';
  }

  /**
   * Check if element exists (without waiting)
   */
  async exists(locator: Locator): Promise<boolean> {
    return (await locator.count()) > 0;
  }

  /**
   * Reload the current page
   */
  async reload(): Promise<void> {
    await this.page.reload();
  }

  /**
   * Go back in browser history
   */
  async goBack(): Promise<void> {
    await this.page.goBack();
  }

  /**
   * Go forward in browser history
   */
  async goForward(): Promise<void> {
    await this.page.goForward();
  }

  /**
   * Wait for a specific time (use sparingly, prefer waitFor* methods)
   */
  async wait(ms: number): Promise<void> {
    await this.page.waitForTimeout(ms);
  }

  /**
   * Press a keyboard key
   */
  async pressKey(key: string): Promise<void> {
    await this.page.keyboard.press(key);
  }

  /**
   * Type text with a delay between keystrokes
   */
  async typeSlowly(locator: Locator, text: string, delay = 100): Promise<void> {
    await locator.pressSequentially(text, { delay });
  }
}
