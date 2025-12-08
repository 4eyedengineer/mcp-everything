# Test Outputs Directory

This directory contains the results of end-to-end (E2E) tests for MCP server generation.

## Directory Structure

Each test run creates a timestamped subdirectory:

```
test-outputs/
  run-YYYYMMDD-HHMMSS/
    summary.txt                 # Overall test run summary
    bug-report.md               # Generated bug report (if tests failed)
    test1-github-url/           # Test 1: GitHub URL Flow
      conversation-id.txt       # Conversation ID for this test
      sse-events.txt            # Raw SSE events received
      generated-server/         # Copy of generated MCP server code
      npm-install.log           # npm install output (if build validation ran)
      tsc-build.log             # TypeScript compilation output
    test2-service-name/         # Test 2: Service Name Flow
      conversation-id.txt
      sse-events.txt
      generated-server/
    test3-error-recovery/       # Test 3: Error Recovery
      conversation-id.txt
      sse-events.txt
```

## Running the Tests

```bash
# Run all E2E tests
./scripts/e2e-test.sh

# Run with options
./scripts/e2e-test.sh --skip-build       # Skip TypeScript compilation validation
./scripts/e2e-test.sh --skip-cleanup     # Keep all generated files
./scripts/e2e-test.sh --markdown         # Output in markdown format
./scripts/e2e-test.sh --verbose          # Show detailed debug output
```

## Prerequisites

Before running E2E tests, ensure:

1. **Backend is running**: `cd packages/backend && npm run start:dev`
2. **Database is migrated**: `./scripts/run-migrations.sh`
3. **Environment configured**: `.env` file with required variables

## Test Descriptions

### Test 1: GitHub URL Flow (Primary)

**Input**: `Generate an MCP server for https://github.com/anthropics/anthropic-sdk-typescript`

**Expected Flow**:
1. `analyzeIntent` - Detects GitHub URL, intent=generate
2. `researchCoordinator` - Analyzes repository structure
3. `ensembleCoordinator` - 4 specialist agents propose tools
4. `clarificationOrchestrator` - Checks for gaps
5. `refinementLoop` - Generate-Test-Refine cycle

**Success Criteria**:
- All nodes execute without error
- Generated code is syntactically correct
- TypeScript compiles without errors
- Files written to `generated-servers/<conversation-id>/`

### Test 2: Service Name Flow

**Input**: `Generate an MCP server for the GitHub API`

**Expected Flow**:
- Research service finds API documentation
- May trigger clarification for scope (which endpoints?)
- Ensemble proposes tools for repos, issues, PRs

**Success Criteria**:
- Research node executes
- Either completes generation OR triggers clarification
- No unhandled errors

### Test 3: Error Recovery

**Input**: `Generate an MCP server for https://github.com/nonexistent/repo`

**Expected Behavior**:
- Graceful error handling
- User-friendly error message (no stack traces)
- No sensitive information exposed
- Backend remains healthy after error

**Success Criteria**:
- Error is handled gracefully
- No stack traces in response
- Backend health check passes after test

## Interpreting Results

### SSE Events

The `sse-events.txt` file contains raw Server-Sent Events. Key events to look for:

```
data: {"type":"progress","message":"...","currentNode":"analyzeIntent"}
data: {"type":"progress","currentNode":"researchCoordinator",...}
data: {"type":"result","isComplete":true,"generatedCode":{...}}
data: {"type":"error","message":"..."}
```

### Build Validation

If build validation is enabled:
- `npm-install.log` - Should complete without errors
- `tsc-build.log` - Should show no TypeScript errors

### Bug Reports

When tests fail, a `bug-report.md` is generated with:
- List of failed tests
- Error messages
- Duration of each test
- Suggested next steps

## Cleaning Up

Old test runs can be cleaned up manually:

```bash
# Remove all test outputs
rm -rf test-outputs/run-*

# Keep only the last 5 runs
ls -dt test-outputs/run-* | tail -n +6 | xargs rm -rf
```

## Related Issues

- Issue #156: First end-to-end generation test
- Epic #153: Core Validation phase
- Issue #180: Master tracking issue
