#!/usr/bin/env node

/**
 * API Endpoint Test Suite for MCP Everything Backend
 * Provides comprehensive testing of all backend endpoints
 */

const http = require('http');

const API_BASE_URL = 'http://localhost:3000';
const COLORS = {
  PASS: '\x1b[32m',
  FAIL: '\x1b[31m',
  INFO: '\x1b[36m',
  WARN: '\x1b[33m',
  RESET: '\x1b[0m'
};

// Test results tracking
let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const testResults = [];

// Helper function to make HTTP requests
function makeRequest(method, path, data = null, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, API_BASE_URL);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: method,
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: timeout
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const result = {
            statusCode: res.statusCode,
            headers: res.headers,
            body: body
          };

          // Try to parse JSON if possible
          try {
            result.json = JSON.parse(body);
          } catch (e) {
            result.text = body;
          }

          resolve(result);
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Request timeout after ${timeout}ms`));
    });

    if (data) {
      req.write(JSON.stringify(data));
    }

    req.end();
  });
}

// Test runner
async function runTest(name, testFn, options = {}) {
  const startTime = Date.now();
  totalTests++;

  try {
    await testFn();
    const duration = Date.now() - startTime;
    passedTests++;

    const result = {
      name,
      status: 'PASS',
      duration,
      ...options
    };

    testResults.push(result);
    console.log(`${COLORS.PASS}✓${COLORS.RESET} ${name} (${duration}ms)`);
    return result;
  } catch (error) {
    const duration = Date.now() - startTime;
    failedTests++;

    const result = {
      name,
      status: 'FAIL',
      duration,
      error: error.message,
      ...options
    };

    testResults.push(result);
    console.log(`${COLORS.FAIL}✗${COLORS.RESET} ${name} (${duration}ms)`);
    console.log(`  ${COLORS.FAIL}Error: ${error.message}${COLORS.RESET}`);
    return result;
  }
}

// Test assertions
function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

function assertEquals(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `Expected ${expected}, got ${actual}`);
  }
}

function assertIncludes(text, substring, message) {
  if (!text.includes(substring)) {
    throw new Error(message || `Expected text to include "${substring}"`);
  }
}

// API Endpoint Tests
async function testHealthEndpoint() {
  const response = await makeRequest('GET', '/health');
  assertEquals(response.statusCode, 200, 'Status code should be 200');
  assert(response.json, 'Response should be JSON');
  assertEquals(response.json.status, 'ok', 'Status should be ok');
  assert(response.json.timestamp, 'Should have timestamp');
  assertEquals(response.json.service, 'mcp-everything-backend', 'Service name should match');
}

async function testRootEndpoint() {
  const response = await makeRequest('GET', '/');
  assertEquals(response.statusCode, 200, 'Status code should be 200');
  assertIncludes(response.text, 'MCP Everything Backend is running', 'Should return correct message');
}

async function testChatEndpoint() {
  const response = await makeRequest('POST', '/chat', {
    message: 'Hello, test!'
  });

  assertEquals(response.statusCode, 201, 'Status code should be 201');
  assert(response.json, 'Response should be JSON');
  assert(response.json.success, 'Should have success status');
  assert(response.json.conversationId, 'Should have conversation ID');
  assert(response.json.response, 'Should have response text');
}

async function testChatWithGitHubUrl() {
  const response = await makeRequest('POST', '/chat', {
    message: 'Generate MCP server for https://github.com/sindresorhus/is'
  }, 10000);

  assertEquals(response.statusCode, 201, 'Status code should be 201');
  assert(response.json, 'Response should be JSON');
  assertEquals(response.json.intent, 'generate_mcp_server', 'Should detect generation intent');
  assert(response.json.extractedUrl, 'Should extract GitHub URL');
}

async function testChatWithConversationId() {
  const firstResponse = await makeRequest('POST', '/chat', {
    message: 'Hello'
  });

  const conversationId = firstResponse.json.conversationId;

  const secondResponse = await makeRequest('POST', '/chat', {
    message: 'Follow up message',
    conversationId: conversationId
  });

  assertEquals(secondResponse.statusCode, 201, 'Status code should be 201');
  assertEquals(secondResponse.json.conversationId, conversationId, 'Should maintain conversation ID');
}

async function testGenerateEndpointWithSmallRepo() {
  const response = await makeRequest('POST', '/generate', {
    githubUrl: 'https://github.com/sindresorhus/is'
  }, 15000);

  assertEquals(response.statusCode, 201, 'Status code should be 201');
  assert(response.json, 'Response should be JSON');
  assert(response.json.success, 'Should be successful');
  assert(response.json.repository, 'Should have repository info');
  assert(response.json.server, 'Should have server info');
  assert(response.json.server.files, 'Should have generated files');
  assert(response.json.server.files.length > 0, 'Should generate at least one file');
}

async function testInvalidEndpoint() {
  const response = await makeRequest('GET', '/nonexistent');
  assertEquals(response.statusCode, 404, 'Status code should be 404');
}

async function testInvalidMethod() {
  const response = await makeRequest('PUT', '/health');
  assertEquals(response.statusCode, 404, 'Status code should be 404 for invalid method');
}

async function testMissingRequiredField() {
  const response = await makeRequest('POST', '/chat', {});
  assertEquals(response.statusCode, 400, 'Should return 400 for missing required field');
}

async function testInvalidGitHubUrl() {
  const response = await makeRequest('POST', '/generate', {
    githubUrl: 'not-a-url'
  });
  assertEquals(response.statusCode, 400, 'Should return 400 for invalid URL');
}

// Performance test
async function testResponseTime() {
  const endpoints = [
    { method: 'GET', path: '/health', maxTime: 100 },
    { method: 'GET', path: '/', maxTime: 100 },
    { method: 'POST', path: '/chat', data: { message: 'test' }, maxTime: 3000 }
  ];

  for (const endpoint of endpoints) {
    const startTime = Date.now();
    await makeRequest(endpoint.method, endpoint.path, endpoint.data);
    const duration = Date.now() - startTime;

    assert(duration < endpoint.maxTime,
      `${endpoint.path} should respond within ${endpoint.maxTime}ms, took ${duration}ms`);
  }
}

// Main test runner
async function runAllTests() {
  console.log(`\n${COLORS.INFO}=== MCP Everything Backend API Tests ===${COLORS.RESET}\n`);
  console.log(`Testing API at: ${API_BASE_URL}\n`);

  // Basic health checks
  console.log(`${COLORS.INFO}Basic Endpoints:${COLORS.RESET}`);
  await runTest('GET /health', testHealthEndpoint);
  await runTest('GET /', testRootEndpoint);

  // Chat endpoint tests
  console.log(`\n${COLORS.INFO}Chat Endpoint:${COLORS.RESET}`);
  await runTest('POST /chat - Basic message', testChatEndpoint);
  await runTest('POST /chat - GitHub URL detection', testChatWithGitHubUrl);
  await runTest('POST /chat - Conversation continuity', testChatWithConversationId);

  // Generation endpoint tests
  console.log(`\n${COLORS.INFO}Generation Endpoint:${COLORS.RESET}`);
  await runTest('POST /generate - Small repository', testGenerateEndpointWithSmallRepo);

  // Error handling tests
  console.log(`\n${COLORS.INFO}Error Handling:${COLORS.RESET}`);
  await runTest('GET /nonexistent - 404 handling', testInvalidEndpoint);
  await runTest('PUT /health - Invalid method', testInvalidMethod);
  await runTest('POST /chat - Missing required field', testMissingRequiredField);
  await runTest('POST /generate - Invalid URL format', testInvalidGitHubUrl);

  // Performance tests
  console.log(`\n${COLORS.INFO}Performance:${COLORS.RESET}`);
  await runTest('Response time validation', testResponseTime);

  // Summary
  console.log(`\n${COLORS.INFO}=== Test Summary ===${COLORS.RESET}`);
  console.log(`Total: ${totalTests}`);
  console.log(`${COLORS.PASS}Passed: ${passedTests}${COLORS.RESET}`);
  console.log(`${COLORS.FAIL}Failed: ${failedTests}${COLORS.RESET}`);

  const successRate = (passedTests / totalTests * 100).toFixed(1);
  const color = failedTests === 0 ? COLORS.PASS : COLORS.WARN;
  console.log(`${color}Success Rate: ${successRate}%${COLORS.RESET}`);

  // Performance summary
  const avgResponseTime = testResults.reduce((sum, r) => sum + r.duration, 0) / testResults.length;
  console.log(`\n${COLORS.INFO}Average response time: ${avgResponseTime.toFixed(0)}ms${COLORS.RESET}`);

  // Exit code based on test results
  process.exit(failedTests === 0 ? 0 : 1);
}

// Check if server is running
async function checkServerHealth() {
  try {
    await makeRequest('GET', '/health', null, 2000);
    return true;
  } catch (error) {
    return false;
  }
}

// Main execution
async function main() {
  // Check if server is running
  const serverRunning = await checkServerHealth();

  if (!serverRunning) {
    console.error(`${COLORS.FAIL}Error: Backend server is not running at ${API_BASE_URL}${COLORS.RESET}`);
    console.error(`Please start the server with: npm start`);
    process.exit(1);
  }

  // Run tests
  try {
    await runAllTests();
  } catch (error) {
    console.error(`${COLORS.FAIL}Fatal error during test execution:${COLORS.RESET}`, error);
    process.exit(1);
  }
}

// Execute main function
main();