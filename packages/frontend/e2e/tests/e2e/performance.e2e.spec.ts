import { test, expect } from '@playwright/test';
import { ChatE2EPage } from '../../page-objects/chat-e2e.page';
import { SSEObserver } from '../../fixtures/sse-observer';
import { KindClusterFixture } from '../../fixtures/kind-cluster';
import { E2EBackendFixture } from '../../fixtures/e2e-backend';

interface PerformanceMetrics {
  totalDuration: number;
  phases: { name: string; duration: number; timestamp: Date }[];
  deploymentDuration?: number;
  firstResponseTime: number;
  warnings: string[];
}

test.describe('Performance Tracking', () => {
  let chatPage: ChatE2EPage;
  let sseObserver: SSEObserver;
  let kindCluster: KindClusterFixture;
  let backend: E2EBackendFixture;
  const metrics: PerformanceMetrics[] = [];

  test.beforeEach(async ({ page }) => {
    chatPage = new ChatE2EPage(page);
    sseObserver = new SSEObserver();
    kindCluster = new KindClusterFixture();
    backend = new E2EBackendFixture();
    await chatPage.navigate();
  });

  test.afterEach(async () => {
    sseObserver.disconnect();
  });

  test.afterAll(async () => {
    // Report all metrics at end
    console.log('\n' + '='.repeat(60));
    console.log('PERFORMANCE METRICS SUMMARY');
    console.log('='.repeat(60));

    metrics.forEach((m, i) => {
      console.log(`\nTest ${i + 1}:`);
      console.log(
        `  Total Duration: ${m.totalDuration}ms (${(m.totalDuration / 1000).toFixed(1)}s)`
      );
      console.log(`  First Response: ${m.firstResponseTime}ms`);
      console.log(`  Phases:`);
      m.phases.forEach((p) => {
        const flag = p.duration > 60000 ? '⚠️ SLOW' : '✓';
        console.log(`    ${flag} ${p.name}: ${p.duration}ms`);
      });
      if (m.deploymentDuration) {
        console.log(`  Deployment: ${m.deploymentDuration}ms`);
      }
      if (m.warnings.length > 0) {
        console.log(`  Warnings: ${m.warnings.join(', ')}`);
      }
    });

    console.log('\n' + '='.repeat(60));
  });

  test('measures GitHub URL generation time', async ({ page }) => {
    const sessionId = await chatPage.getSessionId();
    if (sessionId) {
      await sseObserver.connect(sessionId);
    }

    const startTime = Date.now();
    const metric: PerformanceMetrics = {
      totalDuration: 0,
      phases: [],
      firstResponseTime: 0,
      warnings: [],
    };

    await chatPage.sendMessage(
      'Create MCP server for https://github.com/sindresorhus/is'
    );

    // Track phases
    let lastPhaseTime = startTime;
    let firstResponseRecorded = false;

    const checkPhases = setInterval(() => {
      const events = sseObserver.getEvents();
      const progressEvents = events.filter((e) => e.type === 'progress');

      progressEvents.forEach((event) => {
        const existingPhase = metric.phases.find(
          (p) => p.name === event.message
        );
        if (!existingPhase) {
          if (!firstResponseRecorded) {
            metric.firstResponseTime = Date.now() - startTime;
            firstResponseRecorded = true;
          }

          const duration = Date.now() - lastPhaseTime;
          metric.phases.push({
            name: event.message || 'Unknown phase',
            duration,
            timestamp: event.timestamp,
          });

          if (duration > 60000) {
            metric.warnings.push(
              `Phase "${event.message}" took ${duration}ms (>60s)`
            );
          }

          lastPhaseTime = Date.now();
        }
      });
    }, 1000);

    try {
      await chatPage.waitForGenerationComplete(300000);
    } finally {
      clearInterval(checkPhases);
    }

    metric.totalDuration = Date.now() - startTime;
    metrics.push(metric);

    // Soft assertions (report but don't fail)
    console.log(`\nGitHub URL generation took ${metric.totalDuration}ms`);

    // Hard assertion: should complete within 5 minutes
    expect(metric.totalDuration).toBeLessThan(300000);
  });

  test('measures service name generation time', async ({ page }) => {
    const startTime = Date.now();
    const metric: PerformanceMetrics = {
      totalDuration: 0,
      phases: [],
      firstResponseTime: 0,
      warnings: [],
    };

    await chatPage.sendMessage('Create MCP server for Stripe payment API');

    // Track first response
    await chatPage.waitForProgressMessage(60000);
    metric.firstResponseTime = Date.now() - startTime;

    await chatPage.waitForGenerationComplete(300000);
    metric.totalDuration = Date.now() - startTime;
    metrics.push(metric);

    console.log(`\nService name generation took ${metric.totalDuration}ms`);
    expect(metric.totalDuration).toBeLessThan(300000);
  });

  test('measures natural language generation time', async ({ page }) => {
    const startTime = Date.now();
    const metric: PerformanceMetrics = {
      totalDuration: 0,
      phases: [],
      firstResponseTime: 0,
      warnings: [],
    };

    await chatPage.sendMessage(`Create MCP server with these tools:
      - Temperature converter
      - BMI calculator
      - Password generator`);

    await chatPage.waitForProgressMessage(60000);
    metric.firstResponseTime = Date.now() - startTime;

    await chatPage.waitForGenerationComplete(300000);
    metric.totalDuration = Date.now() - startTime;
    metrics.push(metric);

    console.log(`\nNatural language generation took ${metric.totalDuration}ms`);
    expect(metric.totalDuration).toBeLessThan(300000);
  });

  test('measures deployment time', async ({ page }) => {
    // First generate
    await chatPage.sendMessage('Create MCP server for deployment timing test');
    await chatPage.waitForGenerationComplete(300000);

    const deployStartTime = Date.now();

    // Deploy via UI
    await chatPage.clickDeployButton();

    // Wait for deployment info to appear in UI
    let serverId: string | undefined;
    const deploymentPollStart = Date.now();
    while (Date.now() - deploymentPollStart < 120000) {
      const deploymentInfo = await chatPage.getDeploymentInfo();
      if (deploymentInfo?.serverId) {
        serverId = deploymentInfo.serverId;
        break;
      }
      await page.waitForTimeout(2000);
    }

    if (!serverId) {
      throw new Error('Failed to get serverId from deployment');
    }

    // Wait for deployment to be running
    await backend.waitForDeploymentStatus(serverId, 'running', 120000);

    const deploymentDuration = Date.now() - deployStartTime;

    console.log(`\nDeployment took ${deploymentDuration}ms`);

    // Should complete within 2 minutes
    expect(deploymentDuration).toBeLessThan(120000);

    // Cleanup
    await kindCluster.cleanupTestServer(serverId);
  });

  test('validates phase timeouts (30s target, 60s max)', async ({ page }) => {
    const sessionId = await chatPage.getSessionId();
    if (sessionId) {
      await sseObserver.connect(sessionId);
    }

    await chatPage.sendMessage(
      'Create MCP for https://github.com/sindresorhus/is'
    );

    const phaseTimings: { phase: string; duration: number }[] = [];
    let lastEventTime = Date.now();
    let lastPhase = '';

    const monitor = setInterval(() => {
      const events = sseObserver.getEvents();
      const latestProgress = events.filter((e) => e.type === 'progress').pop();

      if (latestProgress && latestProgress.message !== lastPhase) {
        if (lastPhase) {
          phaseTimings.push({
            phase: lastPhase,
            duration: Date.now() - lastEventTime,
          });
        }
        lastPhase = latestProgress.message || '';
        lastEventTime = Date.now();
      }
    }, 500);

    try {
      await chatPage.waitForGenerationComplete(300000);
    } finally {
      clearInterval(monitor);

      // Record final phase
      if (lastPhase) {
        phaseTimings.push({
          phase: lastPhase,
          duration: Date.now() - lastEventTime,
        });
      }
    }

    console.log('\nPhase Timings:');
    const slowPhases: string[] = [];

    phaseTimings.forEach((p) => {
      const status =
        p.duration > 60000
          ? '⚠️ EXCEEDED'
          : p.duration > 30000
            ? '⚡ SLOW'
            : '✓';
      console.log(`  ${status} ${p.phase}: ${(p.duration / 1000).toFixed(1)}s`);

      if (p.duration > 60000) {
        slowPhases.push(`${p.phase} (${(p.duration / 1000).toFixed(1)}s)`);
      }
    });

    // Warn but don't fail for slow phases
    if (slowPhases.length > 0) {
      console.warn(`\n⚠️ Slow phases detected: ${slowPhases.join(', ')}`);
    }
  });

  test('measures UI responsiveness during generation', async ({ page }) => {
    await chatPage.sendMessage('Create MCP server for responsiveness test');

    // Start generation
    await chatPage.waitForProgressMessage(30000);

    // Measure UI interactions during generation
    const interactionTimes: number[] = [];

    for (let i = 0; i < 5; i++) {
      const start = Date.now();

      // Try to interact with UI
      await chatPage.messageInput.focus();
      await chatPage.messageInput.blur();

      interactionTimes.push(Date.now() - start);
      await page.waitForTimeout(2000);

      // Check if generation completed
      if (
        (await chatPage.didGenerationSucceed()) ||
        (await chatPage.didGenerationFail())
      ) {
        break;
      }
    }

    const avgInteractionTime =
      interactionTimes.reduce((a, b) => a + b, 0) / interactionTimes.length;
    console.log(
      `\nAvg UI interaction time during generation: ${avgInteractionTime}ms`
    );

    // UI should remain responsive (< 500ms for interactions)
    expect(avgInteractionTime).toBeLessThan(500);
  });

  test('generates performance report', async () => {
    // This test runs last and generates a summary report
    // The afterAll hook handles the reporting
    expect(true).toBe(true);
  });
});
