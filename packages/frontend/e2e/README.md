# MCP Everything - E2E Testing Guide

Comprehensive Playwright E2E test suite for the MCP Everything Angular frontend.

## Quick Start

```bash
# Install Playwright browsers (first time only)
npm run e2e:install

# Run all tests (headless)
npm run e2e

# Run tests with UI mode (recommended for development)
npm run e2e:ui

# Run tests in headed mode (see browser)
npm run e2e:headed

# Debug tests
npm run e2e:debug
```

## Prerequisites

- Node.js >= 20.19.0
- npm >= 10.0.0
- Running backend at http://localhost:3000 (for integration tests)

## Test Structure

```
e2e/
├── tests/                  # Test specs
│   ├── chat.spec.ts       # Chat component tests
│   ├── sse-streaming.spec.ts  # SSE streaming tests
│   ├── conversations.spec.ts  # Conversation management
│   ├── security.spec.ts   # Security & XSS tests
│   └── navigation.spec.ts # Navigation & routing
├── page-objects/          # Page Object Models
│   ├── base.page.ts       # Base page with utilities
│   ├── chat.page.ts       # Chat page interactions
│   ├── sidebar.page.ts    # Sidebar interactions
│   └── top-nav.page.ts    # Top navigation
├── fixtures/              # Test fixtures & mocks
│   ├── test-data.ts       # Test data constants
│   └── mock-backend.ts    # Backend API mocking
└── utils/                 # Helper utilities
```

## Running Tests

### Run All Tests

```bash
npm run e2e
```

### Run Specific Browser

```bash
npm run e2e:chromium
npm run e2e:firefox
npm run e2e:webkit
```

### Run Mobile Tests

```bash
npm run e2e:mobile
```

### Run Specific Test File

```bash
npx playwright test e2e/tests/chat.spec.ts
```

### Run Specific Test

```bash
npx playwright test -g "should send message and receive response"
```

### Run Tests Matching Pattern

```bash
npx playwright test --grep "XSS"
```

## Development Workflow

### 1. UI Mode (Recommended)

Best for development and debugging:

```bash
npm run e2e:ui
```

Features:
- Interactive test runner
- Watch mode
- Time travel debugging
- Pick locator tool

### 2. Headed Mode

See browser during test execution:

```bash
npm run e2e:headed
```

### 3. Debug Mode

Step-by-step debugging:

```bash
npm run e2e:debug
```

Use `await page.pause()` in tests to add breakpoints.

### 4. VS Code Debugging

Install the [Playwright Test for VS Code](https://marketplace.visualstudio.com/items?itemName=ms-playwright.playwright) extension.

Add to `.vscode/launch.json`:

```json
{
  "type": "node",
  "request": "launch",
  "name": "Playwright Debug",
  "program": "${workspaceFolder}/node_modules/@playwright/test/cli.js",
  "args": ["test", "--debug"],
  "console": "integratedTerminal"
}
```

## Writing Tests

### Page Object Pattern

Always use Page Objects for better maintainability:

```typescript
import { test } from '@playwright/test';
import { ChatPage } from '../page-objects/chat.page';

test('my test', async ({ page }) => {
  const chatPage = new ChatPage(page);
  await chatPage.navigate();
  await chatPage.sendMessage('Hello');
  await chatPage.waitForAssistantResponse();
});
```

### Using Mock Backend

For isolated tests without backend dependency:

```typescript
import { MockBackend } from '../fixtures/mock-backend';

test('mock test', async ({ page }) => {
  const mockBackend = new MockBackend(page);
  await mockBackend.mockHappyPath();

  // Your test code
});
```

### Common Patterns

#### Waiting for Elements

```typescript
// Wait for element to be visible
await chatPage.waitForAssistantResponse(30000);

// Wait for URL change
await page.waitForURL(/\/chat\/[a-f0-9-]+/);

// Wait for network idle
await chatPage.waitForAngular();
```

#### Assertions

```typescript
import { expect } from '@playwright/test';

// Element visibility
await expect(chatPage.welcomeScreen).toBeVisible();

// Text content
await expect(chatPage.userMessages.first()).toContainText('Hello');

// Count
const count = await chatPage.getMessageCount();
expect(count).toBeGreaterThan(0);
```

#### Handling Async Operations

```typescript
// SSE streaming
await mockBackend.mockSSEStream([...events]);
await chatPage.sendMessage('Test');
await chatPage.waitForProgressMessage();

// Downloads
const downloadPromise = page.waitForEvent('download');
await chatPage.downloadButton.click();
const download = await downloadPromise;
```

## Test Data

Use constants from [test-data.ts](./fixtures/test-data.ts):

```typescript
import { TEST_MESSAGES, TIMEOUTS } from '../fixtures/test-data';

await chatPage.sendMessage(TEST_MESSAGES.simple);
await chatPage.waitForUserMessage(TIMEOUTS.medium);
```

## Mocking Backend APIs

### Complete Happy Path

```typescript
await mockBackend.mockHappyPath();
```

Mocks:
- Chat message API
- SSE stream with progress → result → complete
- Conversations API
- Health check

### Custom SSE Events

```typescript
await mockBackend.mockSSEStream([
  { type: 'progress', message: 'Step 1...' },
  { type: 'result', message: 'Response' },
  { type: 'complete', data: { generatedCode: {...} } }
]);
```

### Error Scenarios

```typescript
// Network error
await mockBackend.mockNetworkError('**/api/chat/message');

// Server error
await mockBackend.mockServerError('**/api/chat/message', 'Custom error');

// Timeout
await mockBackend.mockTimeout('**/api/chat/message', 30000);
```

## Debugging Tips

### 1. Screenshots on Failure

Automatically captured in `e2e/test-results/`.

Manual screenshot:

```typescript
await page.screenshot({ path: 'debug.png' });
```

### 2. Video Recording

Videos saved on first retry in `e2e/test-results/`.

### 3. Trace Viewer

After test failure:

```bash
npx playwright show-trace e2e/test-results/.../trace.zip
```

### 4. Console Logs

```typescript
page.on('console', msg => console.log('PAGE LOG:', msg.text()));
```

### 5. Network Inspection

```typescript
page.on('request', req => console.log('→', req.method(), req.url()));
page.on('response', res => console.log('←', res.status(), res.url()));
```

### 6. Slow Motion

```typescript
// In playwright.config.ts
use: {
  launchOptions: {
    slowMo: 500 // 500ms delay between actions
  }
}
```

## Best Practices

### ✅ Do

- Use Page Objects for all interactions
- Use data-testid attributes for stable selectors
- Wait for elements explicitly (avoid `page.waitForTimeout`)
- Mock backend for unit-style tests
- Use fixtures for common setup
- Test one thing per test
- Use descriptive test names
- Clean up after tests (auto-handled by Playwright)

### ❌ Don't

- Use CSS selectors directly in tests
- Hard-code timeouts
- Test implementation details
- Share state between tests
- Use `page.waitForTimeout()` unless absolutely necessary
- Ignore flaky tests (fix them!)

## CI/CD Integration

### GitHub Actions

Create `.github/workflows/e2e-tests.yml`:

```yaml
name: E2E Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '20'

      - name: Install dependencies
        run: npm ci

      - name: Install Playwright
        run: npx playwright install --with-deps

      - name: Run E2E tests
        run: npm run e2e

      - uses: actions/upload-artifact@v3
        if: always()
        with:
          name: playwright-report
          path: e2e/playwright-report/
```

### Running in CI

```bash
CI=true npm run e2e
```

This enables:
- No parallel execution
- Retries on failure
- HTML report generation

## Test Reports

### View HTML Report

```bash
npm run e2e:report
```

### JSON Results

Available at `e2e/test-results.json` for custom processing.

## Accessibility Testing

Add accessibility checks to tests:

```typescript
import { expect, test } from '@playwright/test';

test('should be accessible', async ({ page }) => {
  await page.goto('/chat');

  // Check ARIA labels
  await expect(page.locator('[aria-label="Send message"]')).toBeVisible();

  // Check keyboard navigation
  await page.keyboard.press('Tab');
  await expect(chatPage.messageInput).toBeFocused();
});
```

## Performance Testing

Track performance metrics:

```typescript
test('should load quickly', async ({ page }) => {
  const start = Date.now();
  await page.goto('/chat');
  await page.waitForLoadState('networkidle');
  const loadTime = Date.now() - start;

  expect(loadTime).toBeLessThan(3000); // 3 seconds
});
```

## Visual Regression Testing

Compare screenshots:

```typescript
test('should match snapshot', async ({ page }) => {
  await page.goto('/chat');
  await expect(page).toHaveScreenshot('chat-page.png');
});
```

Update snapshots:

```bash
npm run e2e -- --update-snapshots
```

## Troubleshooting

### Tests Timing Out

- Increase timeout in test or config
- Check if backend is running
- Use `--headed` to see what's happening

### Flaky Tests

- Add explicit waits
- Check for race conditions
- Use `test.retry()` for known flaky tests

### Element Not Found

- Verify selector with Pick Locator tool in UI mode
- Check if element is in shadow DOM
- Wait for element with `waitFor()`

### SSE Connection Issues

- Ensure backend is running
- Check CORS configuration
- Verify session ID in localStorage

## Test Coverage

Current coverage:

- ✅ Chat component interactions
- ✅ SSE streaming (progress, result, complete, error)
- ✅ Conversation management (create, load, switch)
- ✅ Navigation (routing, sidebar, mobile)
- ✅ Security (XSS prevention, input validation)
- ✅ Keyboard navigation
- ✅ Mobile responsive design
- ✅ Core Features - Chat, AI, Generation (Layer 5)
- ⏳ Download functionality (mocked)
- ⏳ Account settings
- ⏳ Explore page

## Layer 5: Core Features Tests

The core features tests validate the complete AI pipeline:

### Prerequisites

1. **Backend running**: `cd packages/backend && npm run start:dev`
2. **ANTHROPIC_API_KEY**: Must be configured in backend `.env`
3. **Frontend running**: `npm run start` (auto-started by Playwright)

### Running Core Features Tests

```bash
# Run all core features tests (mocked + real API)
npm run e2e:core-features

# Run with visible browser
npm run e2e:core-features:headed

# Run only mocked tests (fast, free)
npm run e2e:core-features:mocked

# Run only real API tests (slow, costs money)
npm run e2e:core-features:real

# Debug mode
npm run e2e:core-features:debug
```

### Test Structure

| Test | Mode | Description | Time |
|------|------|-------------|------|
| 5.1 Send Message | Mocked | User message appears in chat | < 2s |
| 5.2 AI Response | Mocked | Streaming response via SSE | < 2s |
| 5.3 Help Intent | Mocked | Quick help response | < 2s |
| 5.4 GitHub Generation | Real API | Generate MCP server from URL | 2-5 min |
| 5.5 Download | Real API | Download generated ZIP | 5s |
| 5.6 Service Name | Real API | Handle "Stripe API" input | 30-60s |
| 5.7 Natural Language | Real API | Handle description input | 30-60s |
| 5.8 Clarification | Real API | Vague input triggers questions | 1-2 min |
| 5.9 Context | Real API | Conversation memory | 10-30s |

### Cost Considerations

- **Mocked tests** (5.1-5.3): Free, fast, reliable
- **Real API tests** (5.4-5.9): ~$0.001-0.01 per test
- **Full suite**: ~$0.05-0.10 total
- **Run time**: ~10-15 minutes total

### Troubleshooting

**No response after sending message:**
- Check backend logs for errors
- Verify ANTHROPIC_API_KEY is valid
- Check SSE connection in Network tab

**Progress stuck on one phase:**
- Check backend logs for stuck node
- May be rate limited by Claude API

**Generation fails:**
- Check refinement loop iteration count
- Look for compilation errors in logs

## Known Issues

### XSS Vulnerability

**CRITICAL**: The chat component uses `[innerHTML]` without sanitization ([chat.component.html:70](../src/app/features/chat/chat.component.html#L70)).

Security tests will **FAIL** until this is fixed. See [security.spec.ts](./tests/security.spec.ts) for details.

**Recommended Fix:**

```typescript
// Use DomSanitizer
constructor(private sanitizer: DomSanitizer) {}

// In template
<div [innerHTML]="sanitizer.sanitize(SecurityContext.HTML, message.content)"></div>

// Or better: use textContent
<div [textContent]="message.content"></div>
```

## Resources

- [Playwright Documentation](https://playwright.dev/)
- [Playwright Best Practices](https://playwright.dev/docs/best-practices)
- [Angular Testing Guide](https://angular.io/guide/testing)
- [MCP Everything Architecture](../../ARCHITECTURE.md)

## Support

For issues or questions:
1. Check this README
2. Review [PLAYWRIGHT_TEST_STRATEGY.md](../../PLAYWRIGHT_TEST_STRATEGY.md)
3. Open an issue on GitHub
4. Ask in team chat

---

**Last Updated**: December 2025
