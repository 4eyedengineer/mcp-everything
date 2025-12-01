# MCP Testing Service Architecture

## High-Level Design

```
┌─────────────────────────────────────────────────────────────┐
│                    McpTestingService                        │
│                   (Main Orchestrator)                       │
└────────────────┬────────────────────────────────────────────┘
                 │
    ┌────────────┼────────────┬──────────────┐
    │            │            │              │
    v            v            v              v
┌────────┐ ┌────────────┐ ┌────────────┐ ┌──────────┐
│ Build  │ │ Container  │ │   MCP      │ │ Cleanup  │
│Docker  │ │  Lifecycle │ │  Protocol  │ │  Docker  │
│Image   │ │ Management │ │   Testing  │ │Resources │
└────────┘ └────────────┘ └────────────┘ └──────────┘
    │            │            │              │
    └────────────┴────────────┴──────────────┘
                 │
         ┌───────v────────┐
         │ Real-time SSE  │
         │    Progress    │
         │    Streaming   │
         └────────────────┘
```

## Component Architecture

### 1. McpTestingService (Core)

**Responsibility**: Orchestrates the entire testing workflow

**Key Methods**:
- `testMcpServer()` - Main orchestration method
- `registerProgressCallback()` / `unregisterProgressCallback()` - Real-time streaming
- `streamProgress()` - Internal progress notification
- `getTestSummary()` - Result summary

**Lifecycle**:
```
Input: GeneratedCode
  │
  ├─> createTempServerDir() [Temp directory prep]
  │
  ├─> buildDockerImage() [Docker build]
  │
  ├─> runDockerContainer() [Container startup]
  │
  ├─> testMcpTool() × N [Tool testing loop]
  │   ├─> sendMcpMessage() [Protocol communication]
  │   └─> validateMcpResponse() [Response validation]
  │
  ├─> cleanupDocker() [Resource cleanup]
  │
  └─> Return: McpServerTestResult
```

### 2. Dockerfile Generation

**Generated Dockerfile Characteristics**:
- Base: `node:20-alpine` (150MB)
- Multi-layer build process
- Dependencies cached efficiently
- Read-only filesystem where possible
- Health checks included

**Security Hardening**:
```dockerfile
# Non-root execution (implicit in node:20-alpine)
USER node

# Health check
HEALTHCHECK --interval=10s --timeout=5s

# Minimal attack surface
RUN npm cache clean --force
```

### 3. Container Lifecycle Management

**Docker Run Configuration**:
```bash
docker run \
  --rm                                # Auto-cleanup
  --detach                            # Background execution
  --name=${containerId}               # Unique identifier
  --cpus=0.5                          # CPU limit (50%)
  --memory=512m                       # Memory limit
  --memory-swap=512m                  # Swap limit
  --network=none                      # Network isolation
  --read-only                         # Filesystem protection
  --cap-drop=ALL                      # Drop all capabilities
  --security-opt=no-new-privileges    # Prevent privilege escalation
  --ulimit nofile=1024:1024           # File descriptor limit
  --pids-limit=64                     # Process limit
  ${imageTag}
```

**Container States**:
```
Running → Testing Tools → Cleaning → Removed
         ↓
      Error → Cleanup → Removed
```

### 4. MCP Protocol Testing

**Test Flow**:
```
Container Ready
  │
  ├─> Send: tools/list
  │   └─> Receive: { jsonrpc: "2.0", id: X, result: { tools: [...] } }
  │       └─> Verify tool in list
  │
  ├─> Send: tools/call
  │   └─> Receive: { jsonrpc: "2.0", id: Y, result: { content: [...] } }
  │       └─> Validate response format
  │
  └─> Result: ToolTestResult { success, executionTime, ... }
```

**Docker Exec Message Flow**:
```
Node.js stdin → docker exec -i container_id node -e "process.stdin..." → stdout
                ↓
            Parse JSON → Validate → Return
```

### 5. Real-Time Progress Streaming

**SSE Implementation**:
```typescript
┌──────────────────────────────────────────┐
│     Testing Flow with SSE Updates        │
├──────────────────────────────────────────┤
│ Event: 'building'                        │
│ Message: "Building Docker image..."      │
│ ────────────────────────────────────────│
│ Event: 'starting'                        │
│ Message: "Starting container..."         │
│ ────────────────────────────────────────│
│ Event: 'testing'                         │
│ Message: "Testing 5 tools..."            │
│ ────────────────────────────────────────│
│ Event: 'testing_tool' (repeated)         │
│ Message: "Testing tool..."               │
│ Progress: 1/5, 2/5, 3/5, ...             │
│ ────────────────────────────────────────│
│ Event: 'complete'                        │
│ Message: "Test completed: 5/5 passed"    │
│ ────────────────────────────────────────│
│ Event: 'final_result'                    │
│ Data: { result: McpServerTestResult }    │
└──────────────────────────────────────────┘
```

## Security Architecture

### Container Isolation Layers

**Layer 1: Resource Limits**
```
CPU:     0.5 cores (50% of single core)
Memory:  512MB hard limit, no swap excess
I/O:     Default (not explicitly limited in MVP)
```

**Layer 2: Network Isolation**
```
Network Mode: none
Result: Container cannot connect to any network
```

**Layer 3: Filesystem Protection**
```
Read-Only: /
Exceptions: /tmp, /var/tmp (temporary data only)
```

**Layer 4: Process Isolation**
```
PID Limit: 64 processes max
FD Limit: 1024 file descriptors max
Capabilities: ALL dropped (then selectively add if needed)
```

**Layer 5: Privilege Restrictions**
```
No Privilege Escalation: security-opt=no-new-privileges
No Root Escalation: Implicit (node user in Alpine)
```

### Error Containment

**Catastrophic Failures Prevented**:
- Fork bomb: PID limit of 64
- Disk fill: Read-only filesystem
- Network attack: No network access
- Memory exhaustion: 512MB hard limit
- CPU starvation: 0.5 CPU limit
- Privilege escalation: Disabled

## Error Handling Strategy

### Build Phase Errors

```
Build Error
  │
  ├─> Error Message Captured
  │
  ├─> Container Not Started (skip container testing)
  │
  ├─> No Cleanup Needed (image not created)
  │
  └─> Return: buildSuccess=false, results=[]
```

### Container Phase Errors

```
Container Error
  │
  ├─> Attempt Emergency Cleanup
  │   ├─> docker stop
  │   └─> docker rm
  │
  ├─> Log Cleanup Errors
  │
  └─> Return: cleanupSuccess=false, cleanupErrors=[...]
```

### Tool Testing Errors

```
Tool Error
  │
  ├─> Capture Error Message
  │
  ├─> Continue Testing Other Tools
  │
  ├─> Mark as Failed
  │
  └─> Return: success=false, error=message
```

### Cleanup Errors (Non-blocking)

```
Cleanup Error
  │
  ├─> Log Error
  │
  ├─> Add to cleanupErrors Array
  │
  ├─> Continue with Other Resources
  │
  └─> Return: cleanupSuccess=false, cleanupErrors=[...]
```

## Performance Optimization

### Caching Strategy

**Docker Layer Caching**:
- Base image cached (pulled once)
- Dependencies cached (same package.json)
- Build time: 30-60s (first) → 10-15s (cached)

**Future Opportunities**:
- Pre-built base images with common deps
- Build cache mounts for npm modules
- Parallel tool testing (if CPU allows)

### Parallel Execution

**Current (Sequential)**:
```
Tool 1 → Tool 2 → Tool 3 → Tool 4 → Tool 5
Time: ~5 tools × 1s = 5s
```

**Future (Parallel within limits)**:
```
Tool 1 ┐
Tool 2 ├─> Parallel (if CPU allows)
Tool 3 ┘
Time: ~5 tools / 2 parallel = ~3s
```

## Integration Points

### With McpGenerationService

```typescript
// Generation → Testing Loop
const generatedCode = await generationService.generateMCPServer(...);
const testResult = await testingService.testMcpServer(generatedCode);

if (!testResult.overallSuccess) {
  // Regenerate with feedback
  const feedback = analyzeFailures(testResult);
  const regenerated = await generationService.regenerateWithFeedback(feedback);
  const retestResult = await testingService.testMcpServer(regenerated);
}
```

### With Orchestration (LangGraph)

```typescript
// Refinement Node in Graph
nodes['refine_generated_code'] = async (state) => {
  const testResult = await mcpTestingService.testMcpServer(
    state.generatedCode
  );

  if (testResult.overallSuccess) {
    return { ...state, isComplete: true };
  } else {
    return { ...state, needsRegeneration: true };
  }
};
```

### With Chat Controller (SSE Streaming)

```typescript
// Stream to Frontend
@Sse('test/:sessionId')
async streamTest(@Param('sessionId') sessionId: string) {
  mcpTestingService.registerProgressCallback(sessionId, (update) => {
    observer.next({ data: JSON.stringify(update) });
  });

  const result = await mcpTestingService.testMcpServer(...);
  observer.next({ data: JSON.stringify({ type: 'final_result', result }) });
  observer.complete();
}
```

## Data Flow Diagram

```
User Request
    │
    ├─> POST /api/testing/server (sync)
    │   └─> Return McpServerTestResult immediately
    │
    └─> POST /api/testing/stream/:sessionId (async + SSE)
        │
        ├─> registerProgressCallback(sessionId)
        │
        ├─> Call McpTestingService.testMcpServer()
        │   │
        │   ├─> createTempServerDir()
        │   │   └─> streamProgress('building')
        │   │
        │   ├─> buildDockerImage()
        │   │   └─> streamProgress('building')
        │   │
        │   ├─> runDockerContainer()
        │   │   └─> streamProgress('starting')
        │   │
        │   ├─> testMcpTool() × N
        │   │   ├─> streamProgress('testing')
        │   │   └─> streamProgress('testing_tool') per tool
        │   │
        │   └─> cleanupDocker()
        │       └─> streamProgress('cleanup')
        │
        ├─> Collect streaming updates in Observable
        │
        ├─> Send final_result event
        │
        └─> Complete EventSource

Frontend
    │
    ├─> Receive SSE Updates
    │   ├─> Update UI: "Building Docker image..."
    │   ├─> Update UI: "Starting container..."
    │   ├─> Update UI: "Testing tool 1/5..."
    │   └─> Display final results
    │
    └─> Close EventSource
```

## Testing the Testing Service

### Unit Tests

```typescript
describe('McpTestingService', () => {
  // Test fixture validation
  it('should accept valid GeneratedCode', async () => {
    const result = await service.testMcpServer(FIXTURE_VALID_CODE);
    expect(result.buildSuccess).toBe(true);
  });

  // Test error handling
  it('should handle build errors gracefully', async () => {
    const result = await service.testMcpServer(FIXTURE_BUILD_ERROR);
    expect(result.buildSuccess).toBe(false);
    expect(result.buildError).toBeDefined();
  });

  // Test progress streaming
  it('should stream progress updates', async () => {
    const updates = [];
    service.registerProgressCallback('test', (u) => updates.push(u));

    await service.testMcpServer(FIXTURE_VALID_CODE);

    expect(updates).toContainEqual(expect.objectContaining({ type: 'building' }));
    expect(updates).toContainEqual(expect.objectContaining({ type: 'testing' }));
    expect(updates).toContainEqual(expect.objectContaining({ type: 'complete' }));
  });

  // Test resource cleanup
  it('should cleanup Docker resources even on failure', async () => {
    const result = await service.testMcpServer(FIXTURE_INVALID_CODE);

    const containers = execSync('docker ps -a').toString();
    expect(containers).not.toContain(result.containerId);

    const images = execSync('docker images').toString();
    expect(images).not.toContain(result.imageTag);
  });
});
```

### Integration Tests

```typescript
// Full end-to-end test with real Docker
describe('McpTestingService E2E', () => {
  it('should test real MCP server successfully', async () => {
    const realGeneratedCode = {
      mainFile: readFixtureFile('real-mcp-server.ts'),
      packageJson: readFixtureFile('package.json'),
      tsConfig: readFixtureFile('tsconfig.json'),
      supportingFiles: {},
      metadata: { tools: [...], iteration: 1, serverName: 'test' }
    };

    const result = await service.testMcpServer(realGeneratedCode);

    expect(result.buildSuccess).toBe(true);
    expect(result.toolsPassedCount).toEqual(result.toolsTested);
    expect(result.overallSuccess).toBe(true);
  });
});
```

## Monitoring and Observability

### Metrics Collected

- Build duration (milliseconds)
- Container startup time (milliseconds)
- Tool test execution time (milliseconds)
- Total test duration (milliseconds)
- Tools passed/failed counts
- Build success rate
- Test success rate

### Logs Generated

```
[McpTestingService] Starting MCP server test
[McpTestingService] Created temp directory: /tmp/mcp-testing/...
[McpTestingService] Docker image built in 45230ms
[McpTestingService] Container started: container-id
[McpTestingService] Tool "add" passed
[McpTestingService] Tool "multiply" failed: timeout
[McpTestingService] Test complete: 1/2 tools passed in 52000ms
```

### Future Monitoring

- Prometheus metrics export
- OpenTelemetry tracing
- Health endpoint monitoring
- Alert rules for failures
- Dashboard integration
