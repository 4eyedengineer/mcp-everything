import { Page, Locator } from '@playwright/test';
import { BasePage } from './base.page';

/**
 * Page Object for the Top Navigation Component
 */
export class TopNavPage extends BasePage {
  // Locators
  readonly topNav: Locator;
  readonly hamburgerButton: Locator;
  readonly exploreButton: Locator;
  readonly documentationButton: Locator;
  readonly accountButton: Locator;

  constructor(page: Page) {
    super(page);

    this.topNav = page.locator('.top-nav');
    this.hamburgerButton = page.locator('.hamburger-button');
    // Use routerLink attribute for more reliable selection
    this.exploreButton = page.locator('button[routerLink="/explore"], .nav-button:has-text("Explore")');
    this.documentationButton = page.locator('.nav-icon-button').filter({ has: page.locator('mat-icon:has-text("menu_book")') });
    this.accountButton = page.locator('button[routerLink="/account"], .nav-icon-button:has(mat-icon:has-text("account_circle"))');
  }

  /**
   * Toggle sidebar via hamburger button
   */
  async toggleSidebar(): Promise<void> {
    await this.hamburgerButton.click();
  }

  /**
   * Navigate to Explore page
   */
  async navigateToExplore(): Promise<void> {
    await this.exploreButton.click();
  }

  /**
   * Navigate to Account page
   */
  async navigateToAccount(): Promise<void> {
    await this.accountButton.click();
  }

  /**
   * Click documentation button
   */
  async openDocumentation(): Promise<void> {
    await this.documentationButton.click();
  }

  /**
   * Check if hamburger button is visible
   */
  async isHamburgerVisible(): Promise<boolean> {
    return this.hamburgerButton.isVisible();
  }

  /**
   * Check if explore button is visible
   */
  async isExploreVisible(): Promise<boolean> {
    return this.exploreButton.isVisible();
  }

  /**
   * Check if account button is visible
   */
  async isAccountVisible(): Promise<boolean> {
    return this.accountButton.isVisible();
  }

  /**
   * Check if documentation button is visible
   */
  async isDocumentationVisible(): Promise<boolean> {
    return this.documentationButton.isVisible();
  }

  /**
   * Get explore button text
   */
  async getExploreButtonText(): Promise<string> {
    return this.getText(this.exploreButton);
  }
}
