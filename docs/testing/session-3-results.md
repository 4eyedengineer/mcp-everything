# Session 3: Core Features Testing Results

**Date**: 2025-12-04
**Tester**: Claude (automated)
**Issue**: #108

## Summary

Session 3 tested Layer 5 (Core Features: Chat, AI, MCP Generation). The LangGraph pipeline is functional with successful message handling, AI responses, and MCP server code generation. A critical routing bug was discovered and fixed. Tool validation in Docker containers needs further investigation.

---

## Test Results

### Test 1: Send Simple Message

| Item | Result |
|------|--------|
| User message appears in chat | PASS |
| Loading state shows | PASS |
| Backend log shows message received | PASS |
| No immediate errors | PASS |

**Time to first response:** ~4 seconds

---

### Test 2: Receive AI Response

| Item | Result |
|------|--------|
| Progress message appears | PASS |
| Progress message has spinning icon | PASS |
| Assistant response appears | PASS |
| Loading state clears | PASS |
| Response is relevant/coherent | PASS |

**Response time:** ~5 seconds
**Response content summary:** AI correctly understood and responded to "hello" message with a friendly greeting and offer to help generate MCP servers.

---

### Test 3: Help Intent

| Item | Result |
|------|--------|
| Response appears quickly (< 10s) | PASS |
| Response explains capabilities | PASS |
| No error messages | PASS |

**Response time:** ~5 seconds
**Response content:** Detailed explanation of MCP Everything capabilities including generation from GitHub URLs, API specs, and natural language.

---

### Test 4: GitHub URL Generation (CRITICAL)

| Item | Result |
|------|--------|
| Intent analysis | PASS (0.95 confidence) |
| Research phase | PASS (GitHub + Tavily search) |
| Ensemble phase | PASS (18 tools discovered) |
| Refinement phase | PARTIAL (Docker tests fail) |
| Code generation | PASS (13,263 chars) |
| Download button appears | PASS |

**Test URL Used:** `https://github.com/anthropics/anthropic-sdk-typescript`

**Progress Phases Tracked:**

| Phase | Appeared? | Notes |
|-------|-----------|-------|
| Intent analysis | YES | Detected "generate_mcp" with 0.95 confidence |
| Research | YES | GitHub analysis + 10 Tavily search results |
| Ensemble | YES | 4 specialist agents, 18 tools, consensus=1.00 |
| Clarification | YES | "No clarification needed" |
| Refinement | YES | 5 iterations, 0/18 tools passing validation |

**Total generation time:** ~3 minutes

**Critical Bug Found & Fixed:**
- **Issue:** RefinementService was bypassing ensemble-discovered tools and calling McpGenerationService directly for GitHub URLs
- **Root Cause:** `generateInitialCode()` checked for `githubUrl` before checking if ensemble had already discovered tools
- **Fix Applied:** Modified `refinement.service.ts` to prioritize ensemble tools over McpGenerationService
- **Verification:** Backend logs confirmed "Using 18 tools from ensemble for MCP server generation"

**Remaining Issue:**
- Docker-based tool validation fails (0/18 tools working after 5 iterations)
- Build succeeds but MCP protocol tests fail
- Root cause: Mock test script in `McpTestingService.sendMcpMessage()` or container startup issues

---

### Test 5: Download Generated Code

| Item | Result |
|------|--------|
| Download ZIP button visible | PASS |
| Click triggers download | PASS |
| Toast notification appears | PASS |
| ZIP file is valid | PASS |
| Contains MCP server code | PASS |

**Downloaded file:** `mcp-server.zip` (13,785 bytes)

**ZIP Contents:**
- `src/index.ts` (13,158 bytes) - Full MCP server implementation
- `package.json` (321 bytes) - Valid npm package configuration

**Code Quality Check:**
```typescript
// Generated code includes:
- Proper MCP SDK imports (McpServer, StdioServerTransport)
- Anthropic SDK integration
- Zod schemas for validation (MessageSchema, SendMessageSchema, etc.)
- Model selection (claude-3-5-sonnet, claude-3-opus, claude-3-haiku)
- Token counting functionality
- Valid package.json with correct dependencies
```

---

## Session 3 Completion Summary

### Layer 5 Summary

| Test | Status | Notes |
|------|--------|-------|
| Test 1: Send message | PASS | ~4s response time |
| Test 2: AI response | PASS | ~5s, coherent response |
| Test 3: Help intent | PASS | ~5s, explains capabilities |
| Test 4: GitHub generation | PARTIAL | Code generates, Docker validation fails |
| Test 5: Download code | PASS | Valid ZIP with MCP server code |

### Overall Result: **4.5/5 Tests Passing**

---

## Bugs Found

### Bug 1: Ensemble Tools Bypassed for GitHub URLs (FIXED)

**Severity**: Critical
**Layer**: 5
**Status**: FIXED

**Description**: When a GitHub URL was detected, `RefinementService.generateInitialCode()` would call `McpGenerationService.generateMCPServer(githubUrl)` directly, bypassing the 18 tools discovered by the ensemble agents.

**Root Cause**: The method checked for `githubUrl` presence BEFORE checking if `plan.toolsToGenerate` contained ensemble results.

**Fix Applied** in `src/orchestration/refinement.service.ts`:
```typescript
// PRIORITY: If ensemble already discovered tools, use generateFromPlan
if (plan.toolsToGenerate && plan.toolsToGenerate.length > 0) {
  this.logger.log(`Using ${plan.toolsToGenerate.length} tools from ensemble for MCP server generation`);
  return await this.generateFromPlan(state);
}

// Fallback: Use McpGenerationService only when no ensemble tools exist
const githubUrl = state.extractedData?.githubUrl;
if (githubUrl && githubUrl.trim().length > 0 && githubUrl.includes('github.com')) {
  this.logger.log(`Generating MCP server from GitHub repository (no ensemble tools): ${githubUrl}`);
  // ...
}
```

**Verification**: Backend logs now show "Using 18 tools from ensemble for MCP server generation"

---

### Bug 2: Docker Tool Validation Always Fails

**Severity**: Major
**Layer**: 5
**Status**: OPEN

**Description**: After 5 refinement iterations, 0/18 tools pass Docker-based MCP protocol validation despite successful code generation and Docker build.

**Symptoms:**
- "Build: ✓" shown in UI
- "0/18 tools working" after max iterations
- No specific tool error messages visible

**Suspected Causes:**
1. `McpTestingService.sendMcpMessage()` contains a mock test script that doesn't actually run the generated MCP server
2. Docker container may fail to start due to `--read-only` or `--network=none` constraints
3. Container may exit immediately because MCP servers are stdin/stdout based

**Impact**: Code generation works, but users cannot verify if their generated servers are protocol-compliant.

**Recommendation**:
1. Review `McpTestingService` implementation
2. Add verbose logging to container startup
3. Consider simplifying Docker testing or using direct node execution

---

### Bug 3: @langchain/anthropic top_p=-1 Bug (PATCHED)

**Severity**: Critical (Blocks all LLM calls)
**Layer**: 5
**Status**: PATCHED (workaround applied)

**Description**: The `@langchain/anthropic` library sends `top_p: -1` to Anthropic API, causing 400 Bad Request errors.

**Fix Applied**: Set `topP: undefined` in all `ChatAnthropic` constructors:
- `src/orchestration/refinement.service.ts`
- `src/orchestration/ensemble.service.ts`
- `src/orchestration/clarification.service.ts`
- `src/orchestration/graph-orchestration.service.ts`

**Note**: This is a workaround. The root fix should be in `@langchain/anthropic` library.

---

## Screenshots

No screenshots captured for this session. Tests were primarily backend-focused.

---

## Files Modified During Testing

1. `src/orchestration/refinement.service.ts` - Fixed ensemble tool routing
2. `node_modules/@langchain/anthropic/dist/chat_models.cjs` - Patched top_p bug

---

## Next Steps

1. Investigate and fix Docker tool validation (Bug 2)
2. Consider filing issue with `@langchain/anthropic` for top_p bug
3. Proceed to Session 4: #109 (Deployments + History)
4. Consider adding verbose logging to refinement loop for debugging
