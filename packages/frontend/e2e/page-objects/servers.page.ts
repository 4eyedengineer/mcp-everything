import { Page, Locator } from '@playwright/test';
import { BasePage } from './base.page';

export interface ServerData {
  serverName: string;
  serverId: string;
  status: string;
  endpointUrl: string;
  requestCount: string;
}

/**
 * Page Object for the Servers Management Page (/servers)
 */
export class ServersPage extends BasePage {
  // Main page locators
  readonly serversPage: Locator;
  readonly pageTitle: Locator;
  readonly refreshButton: Locator;
  readonly newServerButton: Locator;

  // State locators
  readonly loadingState: Locator;
  readonly loadingSpinner: Locator;
  readonly errorState: Locator;
  readonly emptyState: Locator;

  // Server cards
  readonly serverCards: Locator;
  readonly serversList: Locator;

  // Modals
  readonly logsModal: Locator;
  readonly confirmModal: Locator;
  readonly confirmDeleteButton: Locator;
  readonly cancelDeleteButton: Locator;

  constructor(page: Page) {
    super(page);

    this.serversPage = page.locator('.servers-page');
    this.pageTitle = page.locator('.servers-header h1');
    this.refreshButton = page.locator('.refresh-button');
    this.newServerButton = page.locator('.header-actions .btn-primary');

    this.loadingState = page.locator('.loading-state');
    this.loadingSpinner = page.locator('.loading-state mat-spinner');
    this.errorState = page.locator('.error-state');
    this.emptyState = page.locator('.empty-state');

    this.serverCards = page.locator('.server-card');
    this.serversList = page.locator('.servers-list');

    this.logsModal = page.locator('mcp-logs-modal');
    this.confirmModal = page.locator('mcp-confirm-modal');
    this.confirmDeleteButton = page.locator('mcp-confirm-modal button').filter({ hasText: 'Delete' });
    this.cancelDeleteButton = page.locator('mcp-confirm-modal button').filter({ hasText: 'Cancel' });
  }

  /**
   * Navigate to servers page
   */
  async navigate(): Promise<void> {
    await this.goto('/servers');
  }

  /**
   * Wait for page to load (loading state to disappear)
   */
  async waitForLoad(timeout = 10000): Promise<void> {
    await this.loadingState.waitFor({ state: 'hidden', timeout });
  }

  /**
   * Check if page is loading
   */
  async isLoading(): Promise<boolean> {
    return this.loadingState.isVisible();
  }

  /**
   * Check if error state is visible
   */
  async hasError(): Promise<boolean> {
    return this.errorState.isVisible();
  }

  /**
   * Get error message
   */
  async getErrorMessage(): Promise<string> {
    return this.getText(this.errorState.locator('p'));
  }

  /**
   * Check if empty state is visible
   */
  async isEmpty(): Promise<boolean> {
    return this.emptyState.isVisible();
  }

  /**
   * Get count of server cards
   */
  async getServerCount(): Promise<number> {
    return this.serverCards.count();
  }

  /**
   * Get all server names
   */
  async getServerNames(): Promise<string[]> {
    const cards = await this.serverCards.all();
    const names: string[] = [];
    for (const card of cards) {
      const name = await this.getText(card.locator('.server-name'));
      names.push(name);
    }
    return names;
  }

  /**
   * Get server card by index
   */
  getServerCard(index: number): Locator {
    return this.serverCards.nth(index);
  }

  /**
   * Get server card by name
   */
  getServerByName(name: string): Locator {
    return this.serverCards.filter({ hasText: name }).first();
  }

  /**
   * Get server status by index
   */
  async getServerStatus(index: number): Promise<string> {
    const card = this.getServerCard(index);
    const classes = await card.getAttribute('class') || '';

    if (classes.includes('running')) return 'running';
    if (classes.includes('stopped')) return 'stopped';
    if (classes.includes('failed')) return 'failed';
    if (classes.includes('pending') || classes.includes('building')) return 'deploying';

    return 'unknown';
  }

  /**
   * Get server data by index
   */
  async getServerData(index: number): Promise<ServerData> {
    const card = this.getServerCard(index);
    const serverName = await this.getText(card.locator('.server-name'));
    const serverId = await this.getText(card.locator('.server-id-text'));
    const status = await this.getServerStatus(index);
    const endpointUrl = await this.getText(card.locator('.server-endpoint code'));
    const requestCount = await this.getText(card.locator('.stat').filter({ hasText: 'requests' }));

    return { serverName, serverId, status, endpointUrl, requestCount };
  }

  /**
   * Click start button on server
   */
  async startServer(index: number): Promise<void> {
    const card = this.getServerCard(index);
    await card.locator('.action-btn').filter({ hasText: 'Start' }).click();
  }

  /**
   * Start server by name
   */
  async startServerByName(name: string): Promise<void> {
    const card = this.getServerByName(name);
    await card.locator('.action-btn').filter({ hasText: 'Start' }).click();
  }

  /**
   * Click stop button on server
   */
  async stopServer(index: number): Promise<void> {
    const card = this.getServerCard(index);
    await card.locator('.action-btn').filter({ hasText: 'Stop' }).click();
  }

  /**
   * Stop server by name
   */
  async stopServerByName(name: string): Promise<void> {
    const card = this.getServerByName(name);
    await card.locator('.action-btn').filter({ hasText: 'Stop' }).click();
  }

  /**
   * Click delete button on server
   */
  async deleteServer(index: number): Promise<void> {
    const card = this.getServerCard(index);
    await card.locator('.action-delete').click();
  }

  /**
   * Delete server by name
   */
  async deleteServerByName(name: string): Promise<void> {
    const card = this.getServerByName(name);
    await card.locator('.action-delete').click();
  }

  /**
   * Confirm delete in confirmation modal
   */
  async confirmDelete(): Promise<void> {
    await this.confirmDeleteButton.click();
  }

  /**
   * Cancel delete in confirmation modal
   */
  async cancelDelete(): Promise<void> {
    await this.cancelDeleteButton.click();
  }

  /**
   * Delete server and confirm
   */
  async deleteServerWithConfirm(index: number): Promise<void> {
    await this.deleteServer(index);
    await this.confirmModal.waitFor({ state: 'visible', timeout: 5000 });
    await this.confirmDelete();
  }

  /**
   * Check if confirmation modal is visible
   */
  async isConfirmModalVisible(): Promise<boolean> {
    return this.confirmModal.isVisible();
  }

  /**
   * Open logs for server
   */
  async openLogs(index: number): Promise<void> {
    const card = this.getServerCard(index);
    await card.locator('.action-btn').filter({ hasText: 'Logs' }).click();
  }

  /**
   * Open logs by server name
   */
  async openLogsByName(name: string): Promise<void> {
    const card = this.getServerByName(name);
    await card.locator('.action-btn').filter({ hasText: 'Logs' }).click();
  }

  /**
   * Check if logs modal is visible
   */
  async isLogsModalVisible(): Promise<boolean> {
    return this.logsModal.isVisible();
  }

  /**
   * Close logs modal
   */
  async closeLogs(): Promise<void> {
    await this.logsModal.locator('[class*="close"]').click();
  }

  /**
   * Get logs content
   */
  async getLogContent(): Promise<string> {
    return this.getText(this.logsModal.locator('.logs-content, pre, code'));
  }

  /**
   * Click refresh button
   */
  async refresh(): Promise<void> {
    await this.refreshButton.click();
  }

  /**
   * Click new server button (navigates to /chat)
   */
  async clickNewServer(): Promise<void> {
    await this.newServerButton.click();
  }

  /**
   * Wait for server status to change
   */
  async waitForServerStatus(index: number, status: string, timeout = 30000): Promise<void> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      const currentStatus = await this.getServerStatus(index);
      if (currentStatus === status) {
        return;
      }
      await this.wait(500);
    }
    throw new Error(`Server did not reach status "${status}" within ${timeout}ms`);
  }

  /**
   * Wait for server to be removed from list
   */
  async waitForServerRemoved(name: string, timeout = 10000): Promise<void> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      const names = await this.getServerNames();
      if (!names.includes(name)) {
        return;
      }
      await this.wait(500);
    }
    throw new Error(`Server "${name}" was not removed within ${timeout}ms`);
  }

  /**
   * Copy endpoint URL for server
   */
  async copyEndpoint(index: number): Promise<void> {
    const card = this.getServerCard(index);
    await card.locator('.copy-btn').click();
  }

  /**
   * Copy Claude config for server
   */
  async copyClaudeConfig(index: number): Promise<void> {
    const card = this.getServerCard(index);
    await card.locator('.action-btn').filter({ hasText: 'Config' }).click();
  }

  /**
   * Check if start button is visible for server
   */
  async hasStartButton(index: number): Promise<boolean> {
    const card = this.getServerCard(index);
    return card.locator('.action-btn').filter({ hasText: 'Start' }).isVisible();
  }

  /**
   * Check if stop button is visible for server
   */
  async hasStopButton(index: number): Promise<boolean> {
    const card = this.getServerCard(index);
    return card.locator('.action-btn').filter({ hasText: 'Stop' }).isVisible();
  }
}
