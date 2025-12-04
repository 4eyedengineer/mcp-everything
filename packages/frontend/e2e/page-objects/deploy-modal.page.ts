import { Page, Locator } from '@playwright/test';
import { BasePage } from './base.page';

/**
 * Page Object for the Deploy Modal Component
 */
export class DeployModalPage extends BasePage {
  // Modal container
  readonly modal: Locator;
  readonly title: Locator;

  // Form fields
  readonly serverNameInput: Locator;
  readonly descriptionInput: Locator;
  readonly envVarsSection: Locator;

  // Buttons
  readonly deployButton: Locator;
  readonly cancelButton: Locator;

  // States
  readonly loadingSpinner: Locator;
  readonly errorMessage: Locator;

  // Cost info
  readonly costEstimate: Locator;

  constructor(page: Page) {
    super(page);

    this.modal = page.locator('.deploy-modal');
    this.title = page.locator('h2[mat-dialog-title]');

    this.serverNameInput = page.locator('input[formControlName="serverName"]');
    this.descriptionInput = page.locator('textarea[formControlName="description"]');
    this.envVarsSection = page.locator('.env-vars-section');

    this.deployButton = page.locator('.deploy-button');
    this.cancelButton = page.locator('.cancel-button');

    this.loadingSpinner = page.locator('.deploy-button mat-spinner');
    this.errorMessage = page.locator('.deploy-modal .error-message');

    this.costEstimate = page.locator('.cost-estimate');
  }

  /**
   * Check if modal is visible
   */
  async isVisible(): Promise<boolean> {
    return this.modal.isVisible();
  }

  /**
   * Wait for modal to appear
   */
  override async waitForVisible(timeout = 5000): Promise<void> {
    await this.modal.waitFor({ state: 'visible', timeout });
  }

  /**
   * Wait for modal to close
   */
  async waitForClose(timeout = 5000): Promise<void> {
    await this.modal.waitFor({ state: 'hidden', timeout });
  }

  /**
   * Get modal title text
   */
  async getTitle(): Promise<string> {
    return this.getText(this.title);
  }

  /**
   * Set server name
   */
  async setServerName(name: string): Promise<void> {
    await this.serverNameInput.clear();
    await this.serverNameInput.fill(name);
  }

  /**
   * Get server name value
   */
  async getServerName(): Promise<string> {
    return await this.serverNameInput.inputValue();
  }

  /**
   * Set description
   */
  async setDescription(description: string): Promise<void> {
    await this.descriptionInput.clear();
    await this.descriptionInput.fill(description);
  }

  /**
   * Get description value
   */
  async getDescription(): Promise<string> {
    return await this.descriptionInput.inputValue();
  }

  /**
   * Check if env vars section is visible
   */
  async hasEnvVars(): Promise<boolean> {
    return this.envVarsSection.isVisible();
  }

  /**
   * Get locator for specific env var input
   */
  getEnvVarInput(envVarName: string): Locator {
    return this.page.locator(`input[formControlName="env_${envVarName}"]`);
  }

  /**
   * Set environment variable value
   */
  async setEnvVar(name: string, value: string): Promise<void> {
    const input = this.getEnvVarInput(name);
    await input.clear();
    await input.fill(value);
  }

  /**
   * Get environment variable value
   */
  async getEnvVar(name: string): Promise<string> {
    const input = this.getEnvVarInput(name);
    return await input.inputValue();
  }

  /**
   * Get all env var names displayed
   */
  async getEnvVarNames(): Promise<string[]> {
    const fields = await this.page.locator('.env-var-field mat-label').all();
    const names: string[] = [];
    for (const field of fields) {
      const name = await this.getText(field);
      names.push(name);
    }
    return names;
  }

  /**
   * Click deploy button
   */
  async submit(): Promise<void> {
    await this.deployButton.click();
  }

  /**
   * Click cancel button
   */
  async cancel(): Promise<void> {
    await this.cancelButton.click();
  }

  /**
   * Check if deploy button is disabled
   */
  async isDeployButtonDisabled(): Promise<boolean> {
    return this.deployButton.isDisabled();
  }

  /**
   * Check if submitting (spinner visible)
   */
  async isSubmitting(): Promise<boolean> {
    return this.loadingSpinner.isVisible();
  }

  /**
   * Wait for submitting to complete
   */
  async waitForSubmitComplete(timeout = 30000): Promise<void> {
    // Wait for spinner to appear and then disappear
    try {
      await this.loadingSpinner.waitFor({ state: 'visible', timeout: 2000 });
    } catch {
      // Spinner may have already disappeared
    }
    await this.loadingSpinner.waitFor({ state: 'hidden', timeout });
  }

  /**
   * Check if error is displayed
   */
  async hasError(): Promise<boolean> {
    return this.errorMessage.isVisible();
  }

  /**
   * Get error message text
   */
  async getError(): Promise<string> {
    return this.getText(this.errorMessage);
  }

  /**
   * Get cost estimate text
   */
  async getCostEstimate(): Promise<string> {
    return this.getText(this.costEstimate);
  }

  /**
   * Fill form and submit
   */
  async fillAndSubmit(
    serverName: string,
    description?: string,
    envVars?: Record<string, string>
  ): Promise<void> {
    await this.setServerName(serverName);

    if (description) {
      await this.setDescription(description);
    }

    if (envVars) {
      for (const [name, value] of Object.entries(envVars)) {
        await this.setEnvVar(name, value);
      }
    }

    await this.submit();
  }

  /**
   * Get validation error for server name
   */
  async getServerNameError(): Promise<string | null> {
    const error = this.page.locator('mat-form-field:has(input[formControlName="serverName"]) mat-error');
    if (await error.isVisible()) {
      return this.getText(error);
    }
    return null;
  }

  /**
   * Get validation error for description
   */
  async getDescriptionError(): Promise<string | null> {
    const error = this.page.locator('mat-form-field:has(textarea[formControlName="description"]) mat-error');
    if (await error.isVisible()) {
      return this.getText(error);
    }
    return null;
  }

  /**
   * Get validation error for an env var
   */
  async getEnvVarError(name: string): Promise<string | null> {
    const error = this.page.locator(`mat-form-field:has(input[formControlName="env_${name}"]) mat-error`);
    if (await error.isVisible()) {
      return this.getText(error);
    }
    return null;
  }
}
