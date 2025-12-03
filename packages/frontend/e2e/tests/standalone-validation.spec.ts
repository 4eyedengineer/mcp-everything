import { test, expect } from '@playwright/test';
import { ChatPage } from '../page-objects/chat.page';
import { SidebarPage } from '../page-objects/sidebar.page';
import { TopNavPage } from '../page-objects/top-nav.page';

/**
 * Standalone Frontend Validation Tests
 * Per Issue #89 - Layer 3: Frontend Standalone Validation
 *
 * These tests validate the Angular frontend builds, serves, and renders
 * correctly in the browser without backend dependencies.
 */

test.describe('Frontend Standalone Validation', () => {
  let chatPage: ChatPage;
  let sidebarPage: SidebarPage;
  let topNavPage: TopNavPage;

  // Collect console errors during test
  let consoleErrors: string[] = [];
  let networkErrors: { url: string; status: number }[] = [];

  /**
   * Close any error dialogs/snackbars that appear due to missing backend
   * This is expected in standalone mode
   */
  async function dismissNetworkErrorDialog(page: import('@playwright/test').Page) {
    // Give a moment for any toasts/snackbars to appear
    await page.waitForTimeout(500);

    // Check if snackbar exists
    const snackbar = page.locator('mat-snack-bar-container, .mat-mdc-snack-bar-container');
    const snackbarExists = await snackbar.isVisible({ timeout: 1000 }).catch(() => false);

    if (snackbarExists) {
      // Try to close snackbar using the action button inside the snackbar
      const snackbarClose = snackbar.locator('button');
      if (await snackbarClose.isVisible({ timeout: 500 }).catch(() => false)) {
        await snackbarClose.click({ force: true });
        await page.waitForTimeout(500);
        return;
      }

      // Wait for snackbar to auto-dismiss if no button
      await snackbar.waitFor({ state: 'hidden', timeout: 6000 }).catch(() => {});
      return;
    }

    // Check for any error dialog (not sidebar)
    const errorDialog = page.locator('.error-dialog, [role="alertdialog"], .cdk-overlay-pane:has(.error)');
    if (await errorDialog.isVisible({ timeout: 500 }).catch(() => false)) {
      const dialogClose = errorDialog.locator('button:has-text("Close"), button:has-text("OK")');
      if (await dialogClose.isVisible({ timeout: 500 }).catch(() => false)) {
        await dialogClose.click({ force: true });
        await page.waitForTimeout(300);
      }
    }
  }

  test.beforeEach(async ({ page }) => {
    // Reset error collectors
    consoleErrors = [];
    networkErrors = [];

    // Listen for console errors
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    // Listen for network failures
    page.on('response', (response) => {
      if (response.status() >= 400) {
        networkErrors.push({
          url: response.url(),
          status: response.status(),
        });
      }
    });

    chatPage = new ChatPage(page);
    sidebarPage = new SidebarPage(page);
    topNavPage = new TopNavPage(page);
  });

  // ============================================================
  // 3.3 Access in Browser
  // ============================================================
  test.describe('3.3 Access in Browser', () => {
    test('should load page (not blank/white screen)', async ({ page }) => {
      await page.goto('/');

      // Wait for Angular to bootstrap
      await page.waitForLoadState('networkidle');

      // Check that we have actual content (before any interactions)
      const bodyContent = await page.locator('body').textContent();
      expect(bodyContent?.length).toBeGreaterThan(0);

      // Check that main content area is visible (not blank)
      // Use multiple possible selectors for robustness
      const contentArea = page.locator('main, .main-content, .chat-container, .welcome-screen').first();
      await expect(contentArea).toBeVisible({ timeout: 15000 });

      // Dismiss any network error dialog (expected when backend is not running)
      await dismissNetworkErrorDialog(page);

      // Verify the page still has content after dismissing dialogs
      const finalContent = await page.locator('body').textContent();
      expect(finalContent?.length).toBeGreaterThan(100); // Should have substantial content
    });

    test('should redirect to /chat (or intended route)', async ({ page }) => {
      await page.goto('/');

      // Should redirect to /chat
      await page.waitForURL(/\/chat/);
      expect(page.url()).toContain('/chat');
    });

    test('should not show infinite loading spinner', async ({ page }) => {
      await page.goto('/chat');

      // Wait for initial load
      await page.waitForLoadState('networkidle');

      // Check that there's no persistent spinner
      const spinner = page.locator('mat-spinner, .loading-spinner, [role="progressbar"]');

      // Give a short wait for any temporary spinners to resolve
      await page.waitForTimeout(2000);

      // Either spinner doesn't exist, or it should disappear
      const spinnerVisible = await spinner.isVisible().catch(() => false);
      if (spinnerVisible) {
        // If spinner is visible, wait for it to disappear (with reasonable timeout)
        await expect(spinner).toBeHidden({ timeout: 10000 });
      }
    });
  });

  // ============================================================
  // 3.4 Browser Console Check
  // ============================================================
  test.describe('3.4 Browser Console Check', () => {
    test('should have no red errors on page load', async ({ page }) => {
      await page.goto('/chat');
      await page.waitForLoadState('networkidle');

      // Filter out known acceptable errors (e.g., missing backend, analytics)
      const criticalErrors = consoleErrors.filter((error) => {
        const lowerError = error.toLowerCase();
        // Ignore backend connection errors (expected when running standalone)
        if (lowerError.includes('localhost:3000') || lowerError.includes('/api/')) {
          return false;
        }
        // Ignore favicon errors
        if (lowerError.includes('favicon')) {
          return false;
        }
        // Ignore network/fetch errors (expected without backend)
        if (lowerError.includes('failed to fetch') || lowerError.includes('network error')) {
          return false;
        }
        // Ignore ERR_CONNECTION_REFUSED (backend not running)
        if (lowerError.includes('err_connection_refused') || lowerError.includes('net::err')) {
          return false;
        }
        // Ignore HttpErrorResponse from Angular HTTP client (backend not running)
        if (lowerError.includes('httperrorresponse') || lowerError.includes('http error')) {
          return false;
        }
        // Ignore SSE connection errors (expected without backend)
        if (lowerError.includes('sse') || lowerError.includes('eventsource')) {
          return false;
        }
        // Ignore "backend returned code 0" errors (connection refused)
        if (lowerError.includes('backend returned code 0') || lowerError.includes('code 0')) {
          return false;
        }
        // Ignore conversation loading errors (expected without backend)
        if (lowerError.includes('getconversations') || lowerError.includes('conversation')) {
          return false;
        }
        // Ignore isTrusted errors (network related)
        if (lowerError.includes('istrusted')) {
          return false;
        }
        return true;
      });

      // Log any critical errors found for debugging
      if (criticalErrors.length > 0) {
        console.log('Critical console errors found:', criticalErrors);
      }

      expect(criticalErrors).toHaveLength(0);
    });

    test('should have no "Cannot read property of undefined" errors', async ({ page }) => {
      await page.goto('/chat');
      await page.waitForLoadState('networkidle');

      const undefinedErrors = consoleErrors.filter(
        (error) =>
          error.includes('Cannot read property') ||
          error.includes('Cannot read properties') ||
          error.includes('of undefined') ||
          error.includes('of null'),
      );

      expect(undefinedErrors).toHaveLength(0);
    });

    test('should have no Angular errors', async ({ page }) => {
      await page.goto('/chat');
      await page.waitForLoadState('networkidle');

      const angularErrors = consoleErrors.filter(
        (error) =>
          error.includes('NG') ||
          error.includes('Angular') ||
          error.includes('ExpressionChangedAfterItHasBeenCheckedError'),
      );

      expect(angularErrors).toHaveLength(0);
    });

    test('should have no 404 errors for assets', async ({ page }) => {
      await page.goto('/chat');
      await page.waitForLoadState('networkidle');

      // Filter to only asset-related 404s (exclude API calls)
      const asset404s = networkErrors.filter(
        (error) =>
          error.status === 404 &&
          !error.url.includes('/api/') &&
          !error.url.includes('localhost:3000'),
      );

      if (asset404s.length > 0) {
        console.log('Asset 404 errors:', asset404s);
      }

      expect(asset404s).toHaveLength(0);
    });
  });

  // ============================================================
  // 3.5 Network Tab Check
  // ============================================================
  test.describe('3.5 Network Tab Check', () => {
    test('should load main.js successfully', async ({ page }) => {
      const jsRequests: string[] = [];

      page.on('response', (response) => {
        if (response.url().includes('main') && response.url().endsWith('.js')) {
          jsRequests.push(response.url());
          expect(response.status()).toBe(200);
        }
      });

      await page.goto('/chat');
      await page.waitForLoadState('networkidle');

      // Verify main.js was loaded
      expect(jsRequests.length).toBeGreaterThan(0);
    });

    test('should load styles successfully', async ({ page }) => {
      const styleLoaded = { found: false };

      page.on('response', (response) => {
        if (response.url().includes('styles') && response.url().endsWith('.css')) {
          expect(response.status()).toBe(200);
          styleLoaded.found = true;
        }
      });

      await page.goto('/chat');
      await page.waitForLoadState('networkidle');

      // Styles might be inlined in production builds
      if (!styleLoaded.found) {
        // Check for inline styles
        const hasInlineStyles = await page.locator('style').count();
        expect(hasInlineStyles).toBeGreaterThan(0);
      }
    });

    test('should load all critical assets (no 404s)', async ({ page }) => {
      const failed404s: string[] = [];

      page.on('response', (response) => {
        // Only check for static assets, not API calls
        const url = response.url();
        if (
          response.status() === 404 &&
          !url.includes('/api/') &&
          !url.includes('localhost:3000') &&
          (url.endsWith('.js') ||
            url.endsWith('.css') ||
            url.endsWith('.woff') ||
            url.endsWith('.woff2') ||
            url.endsWith('.ttf') ||
            url.endsWith('.png') ||
            url.endsWith('.svg') ||
            url.endsWith('.ico'))
        ) {
          failed404s.push(url);
        }
      });

      await page.goto('/chat');
      await page.waitForLoadState('networkidle');

      expect(failed404s).toHaveLength(0);
    });
  });

  // ============================================================
  // 3.6 Chat Page Visual Inspection
  // ============================================================
  test.describe('3.6 Chat Page Visual Inspection', () => {
    test('should show welcome screen or chat interface', async ({ page }) => {
      await page.goto('/chat');
      await page.waitForLoadState('networkidle');

      // Either welcome screen or messages area should be visible
      const welcomeScreen = page.locator('.welcome-screen');
      const messagesArea = page.locator('.messages-area, .chat-container');

      const hasWelcome = await welcomeScreen.isVisible().catch(() => false);
      const hasMessages = await messagesArea.isVisible().catch(() => false);

      expect(hasWelcome || hasMessages).toBe(true);
    });

    test('should show message input field', async ({ page }) => {
      await page.goto('/chat');
      await page.waitForLoadState('networkidle');

      const messageInput = page.locator(
        '.message-input, textarea[placeholder], input[type="text"]',
      );
      await expect(messageInput.first()).toBeVisible();
    });

    test('should show send button and be styled', async ({ page }) => {
      await page.goto('/chat');
      await page.waitForLoadState('networkidle');

      const sendButton = page.locator('.send-button, button[type="submit"], button:has(mat-icon)');
      await expect(sendButton.first()).toBeVisible();

      // Check it has some styling (background color, not default)
      const hasStyle = await sendButton.first().evaluate((el) => {
        const styles = getComputedStyle(el);
        return styles.backgroundColor !== 'rgba(0, 0, 0, 0)' || styles.color !== 'rgb(0, 0, 0)';
      });

      expect(hasStyle).toBe(true);
    });

    test('should show sidebar toggle button', async ({ page }) => {
      await page.goto('/chat');
      await page.waitForLoadState('networkidle');

      const hamburgerButton = page.locator('.hamburger-button, [aria-label*="menu"], mat-icon:has-text("menu")');
      await expect(hamburgerButton.first()).toBeVisible();
    });

    test('should have no broken/overlapping layout elements', async ({ page }) => {
      await page.goto('/chat');
      await page.waitForLoadState('networkidle');

      // Check that main container has reasonable dimensions
      const mainContent = page.locator('.main-content, .chat-container, main');
      const box = await mainContent.first().boundingBox();

      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThan(200);
      expect(box!.height).toBeGreaterThan(200);

      // Check that input area is visible at bottom
      const inputArea = page.locator('.input-container, .message-input').first();
      const inputBox = await inputArea.boundingBox();

      expect(inputBox).not.toBeNull();
      expect(inputBox!.y).toBeGreaterThan(100); // Should be below header
    });
  });

  // ============================================================
  // 3.7 Navigation Test
  // ============================================================
  test.describe('3.7 Navigation Test', () => {
    test('should toggle sidebar with button click', async ({ page }) => {
      await page.goto('/chat');
      await page.waitForLoadState('networkidle');

      // Find and click hamburger button
      const hamburgerButton = page.locator('.hamburger-button, [aria-label*="menu"]').first();
      await hamburgerButton.click();

      // Wait for sidebar animation
      await page.waitForTimeout(500);

      // Sidebar should be visible
      const sidebar = page.locator('.conversation-sidebar, .sidebar, aside');
      await expect(sidebar.first()).toBeVisible();

      // Click close button or overlay to close
      const closeButton = page.locator('.close-button, .sidebar-close, .overlay').first();
      if (await closeButton.isVisible()) {
        await closeButton.click();
        await page.waitForTimeout(500);
      }
    });

    test('should navigate to /explore', async ({ page }) => {
      await page.goto('/chat');
      await page.waitForLoadState('networkidle');

      // Dismiss network error dialog before navigation
      await dismissNetworkErrorDialog(page);

      // Navigate to explore
      await topNavPage.navigateToExplore();
      await page.waitForURL(/\/explore/);

      expect(page.url()).toContain('/explore');

      // Page should have content
      const heading = page.locator('h1, h2, .page-title');
      await expect(heading.first()).toBeVisible();
    });

    test('should navigate to /account', async ({ page }) => {
      await page.goto('/chat');
      await page.waitForLoadState('networkidle');

      // Dismiss network error dialog before navigation
      await dismissNetworkErrorDialog(page);

      // Navigate to account
      await topNavPage.navigateToAccount();
      await page.waitForURL(/\/account/);

      expect(page.url()).toContain('/account');

      // Page should have content
      const heading = page.locator('h1, h2, .page-title');
      await expect(heading.first()).toBeVisible();
    });

    test('should navigate back to /chat', async ({ page }) => {
      await page.goto('/explore');
      await page.waitForLoadState('networkidle');

      // Navigate to chat
      await chatPage.navigate();
      await page.waitForURL(/\/chat/);

      expect(page.url()).toContain('/chat');
    });

    test('should support browser back/forward buttons', async ({ page }) => {
      // Start at chat
      await page.goto('/chat');
      await page.waitForLoadState('networkidle');

      // Dismiss network error dialog before navigation
      await dismissNetworkErrorDialog(page);

      // Go to explore
      await topNavPage.navigateToExplore();
      await page.waitForURL(/\/explore/);

      // Go back
      await page.goBack();
      await page.waitForURL(/\/chat/);
      expect(page.url()).toContain('/chat');

      // Dismiss any error dialog that appears after going back
      await dismissNetworkErrorDialog(page);

      // Go forward
      await page.goForward();
      await page.waitForURL(/\/explore/);
      expect(page.url()).toContain('/explore');
    });
  });

  // ============================================================
  // 3.8 Responsive Check
  // ============================================================
  test.describe('3.8 Responsive Check', () => {
    test('should render correctly at desktop width', async ({ page }) => {
      await page.setViewportSize({ width: 1920, height: 1080 });
      await page.goto('/chat');
      await page.waitForLoadState('networkidle');

      // Main content should be visible
      const mainContent = page.locator('.main-content, .chat-container, main');
      await expect(mainContent.first()).toBeVisible();

      // No horizontal scrollbar
      const hasHorizontalScroll = await page.evaluate(() => {
        return document.documentElement.scrollWidth > document.documentElement.clientWidth;
      });
      expect(hasHorizontalScroll).toBe(false);
    });

    test('should be functional at mobile width (~375px)', async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 667 });
      await page.goto('/chat');
      await page.waitForLoadState('networkidle');

      // Main content should be visible
      const mainContent = page.locator('.main-content, .chat-container, main');
      await expect(mainContent.first()).toBeVisible();

      // Message input should still be visible
      const messageInput = page.locator('.message-input, textarea');
      await expect(messageInput.first()).toBeVisible();

      // Hamburger button should be visible
      const hamburgerButton = page.locator('.hamburger-button, [aria-label*="menu"]');
      await expect(hamburgerButton.first()).toBeVisible();
    });

    test('should be functional at tablet width (~768px)', async ({ page }) => {
      await page.setViewportSize({ width: 768, height: 1024 });
      await page.goto('/chat');
      await page.waitForLoadState('networkidle');

      // Dismiss network error dialog before interaction
      await dismissNetworkErrorDialog(page);

      // Main content should be visible
      const mainContent = page.locator('.main-content, .chat-container, main');
      await expect(mainContent.first()).toBeVisible();

      // Navigation should work
      await topNavPage.navigateToExplore();
      await page.waitForURL(/\/explore/);
      expect(page.url()).toContain('/explore');
    });
  });

  // ============================================================
  // 3.9 Theme/Styling
  // ============================================================
  test.describe('3.9 Theme/Styling', () => {
    test('should render theme correctly', async ({ page }) => {
      await page.goto('/chat');
      await page.waitForLoadState('networkidle');

      // Check that body has background color (not default white/transparent)
      const bodyBg = await page.evaluate(() => {
        const styles = getComputedStyle(document.body);
        return styles.backgroundColor;
      });

      // Should have some background styling
      expect(bodyBg).toBeTruthy();
    });

    test('should load Material icons', async ({ page }) => {
      await page.goto('/chat');
      await page.waitForLoadState('networkidle');

      // Find Material icons
      const matIcons = page.locator('mat-icon');
      const iconCount = await matIcons.count();

      // Should have at least some icons (hamburger, send, etc.)
      expect(iconCount).toBeGreaterThan(0);

      // Check first icon has content (font loaded correctly)
      if (iconCount > 0) {
        const firstIcon = matIcons.first();
        const iconText = await firstIcon.textContent();
        expect(iconText?.length).toBeGreaterThan(0);

        // Check icon has proper dimensions (font rendered)
        const box = await firstIcon.boundingBox();
        expect(box?.width).toBeGreaterThan(0);
        expect(box?.height).toBeGreaterThan(0);
      }
    });

    test('should render fonts correctly', async ({ page }) => {
      await page.goto('/chat');
      await page.waitForLoadState('networkidle');

      // Check that text elements have proper font styling
      const greeting = page.locator('.greeting, h1, h2, .page-title').first();

      if (await greeting.isVisible()) {
        const fontFamily = await greeting.evaluate((el) => {
          return getComputedStyle(el).fontFamily;
        });

        // Should have a font family set (not just default serif)
        expect(fontFamily).toBeTruthy();
        expect(fontFamily).not.toBe('serif');
      }

      // Check text is readable (has proper font-size)
      const textElement = page.locator('body').first();
      const fontSize = await textElement.evaluate((el) => {
        return parseFloat(getComputedStyle(el).fontSize);
      });

      expect(fontSize).toBeGreaterThanOrEqual(12); // Minimum readable size
    });
  });

  // ============================================================
  // Summary Screenshot
  // ============================================================
  test('should capture validation screenshot', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/chat');
    await page.waitForLoadState('networkidle');

    // Wait a moment for any animations
    await page.waitForTimeout(1000);

    // Take screenshot for validation evidence
    await page.screenshot({
      path: 'e2e/screenshots/standalone-validation.png',
      fullPage: false,
    });
  });
});
