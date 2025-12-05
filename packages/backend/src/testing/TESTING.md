# MCP Server Testing Service

Production-ready Docker-based testing system for validating generated MCP servers with security isolation, resource limits, and comprehensive test coverage.

## Overview

The `McpTestingService` executes generated MCP servers in isolated Docker containers and validates:

1. **Docker Build Success**: TypeScript compilation and dependency resolution
2. **Container Launch**: Server starts correctly with security constraints
3. **MCP Protocol Compliance**: Tools/list and tools/call endpoints work correctly
4. **Tool Functionality**: Each tool executes and returns properly formatted responses
5. **Resource Constraints**: CPU (50%), Memory (512MB), No network access

## Security Architecture

### Container Isolation

```yaml
Security Features:
  - Network Mode: none (no network access)
  - CPU Limit: 0.5 cores (50%)
  - Memory Limit: 512MB
  - Memory Swap: 512MB (no swap excess)
  - Capabilities Dropped: ALL
  - No Privilege Escalation
  - Read-Only Filesystem
  - File Descriptor Limit: 1024
  - Process Limit: 64
  - Security Opts: no-new-privileges
```

### Automatic Cleanup

- Containers automatically removed after test completion
- Images automatically removed to prevent disk bloat
- Temporary directories removed with file sync
- Cleanup happens even on test failure

## API Usage

### Option 1: Synchronous HTTP Test

Blocks until test completes, returns full results.

```typescript
// POST /api/testing/server
const response = await fetch('http://localhost:3000/api/testing/server', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    generatedCode: {
      mainFile: 'import { Server } from "@modelcontextprotocol/sdk"...',
      packageJson: '{"name": "mcp-server", "version": "0.1.0"...}',
      tsConfig: '{"compilerOptions": {...}}',
      supportingFiles: {},
      metadata: {
        tools: [
          { name: 'analyze', description: 'Analyze text', inputSchema: {...} },
          { name: 'transform', description: 'Transform data', inputSchema: {...} }
        ],
        iteration: 1,
        serverName: 'my-mcp-server'
      }
    },
    cpuLimit: '0.5',        // Optional, default: '0.5'
    memoryLimit: '512m',    // Optional, default: '512m'
    timeout: 120,           // Optional, default: 120 (seconds)
    toolTimeout: 5          // Optional, default: 5 (seconds per tool)
  })
});

const result = await response.json();
// Returns: {
//   success: true,
//   message: "Test completed: 2/2 tools passed",
//   testId: "mcp-test-1701234567890-abc123def",
//   result: {
//     containerId: "mcp-test-1701234567890-abc123def",
//     imageTag: "mcp-test-server:uuid",
//     buildSuccess: true,
//     toolsFound: 2,
//     toolsTested: 2,
//     toolsPassedCount: 2,
//     results: [
//       {
//         toolName: "analyze",
//         success: true,
//         executionTime: 245,
//         mcpCompliant: true,
//         output: {...},
//         timestamp: "2024-01-01T12:00:00Z"
//       },
//       ...
//     ],
//     overallSuccess: true,
//     totalDuration: 45230,
//     cleanupSuccess: true,
//     cleanupErrors: []
//   }
// }
```

### Option 2: Server-Sent Events (SSE) for Real-Time Streaming

Recommended for frontend integration. Shows real-time progress.

```typescript
// POST /api/testing/stream/:sessionId
const sessionId = crypto.randomUUID();
const eventSource = new EventSource(
  `/api/testing/stream/${sessionId}`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      generatedCode: {...},
      cpuLimit: '0.5',
      memoryLimit: '512m',
      timeout: 120,
      toolTimeout: 5
    })
  }
);

eventSource.onmessage = (event) => {
  const update = JSON.parse(event.data);

  switch (update.type) {
    case 'building':
      console.log('Docker build:', update.message);
      // Update UI: "Building Docker image..."
      break;

    case 'starting':
      console.log('Starting container:', update.message);
      // Update UI: "Starting container..."
      break;

    case 'testing':
      console.log('Testing phase:', update.message);
      // Update UI: "Testing 5 tools..."
      break;

    case 'testing_tool':
      console.log(`Testing tool ${update.toolIndex}/${update.totalTools}:`, update.toolName);
      // Update UI: "Testing tool 2/5: transform"
      // Show progress bar: 40%
      break;

    case 'complete':
      console.log('Test complete:', update.message);
      // Update UI: "Test completed: 5/5 tools passed in 45230ms"
      break;

    case 'error':
      console.error('Test error:', update.message);
      // Update UI: "Test failed: ..."
      break;

    case 'cleanup':
      console.log('Cleanup:', update.message);
      // Update UI: "Cleaning up resources..."
      break;

    case 'final_result':
      console.log('Final result:', update.result);
      // Display full test results
      eventSource.close();
      break;
  }
};

eventSource.onerror = (error) => {
  console.error('SSE connection error:', error);
  eventSource.close();
};
```

### Option 3: Polling (Fallback)

For clients that don't support SSE.

```typescript
const sessionId = crypto.randomUUID();

// 1. Start test
fetch(`/api/testing/stream/${sessionId}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ generatedCode: {...} })
});

// 2. Poll for results
const pollInterval = setInterval(async () => {
  const response = await fetch(`/api/testing/results/${sessionId}`, {
    method: 'POST'
  });

  const result = await response.json();

  if (result.result) {
    clearInterval(pollInterval);
    console.log('Test complete:', result);
  }
}, 1000); // Poll every second
```

## Service Integration

### NestJS Module Setup

```typescript
// app.module.ts
import { Module } from '@nestjs/common';
import { TestingModule } from './testing/testing.module';

@Module({
  imports: [
    TestingModule,
    // ... other modules
  ],
})
export class AppModule {}
```

### Direct Service Usage

```typescript
import { McpTestingService } from './testing/mcp-testing.service';

@Injectable()
export class MyService {
  constructor(private mcpTestingService: McpTestingService) {}

  async generateAndTest(githubUrl: string) {
    // Generate code using McpGenerationService
    const generatedCode = await this.generationService.generateMCPServer(githubUrl);

    // Register progress callback for real-time updates
    this.mcpTestingService.registerProgressCallback('my-test', (update) => {
      console.log(`[${update.type}] ${update.message}`);
      if (update.type === 'testing_tool') {
        console.log(`Progress: ${update.toolIndex}/${update.totalTools} - ${update.toolName}`);
      }
    });

    try {
      // Run test
      const testResult = await this.mcpTestingService.testMcpServer(generatedCode, {
        cpuLimit: '0.5',
        memoryLimit: '512m',
        timeout: 120,
        toolTimeout: 5,
        cleanup: true,
      });

      // Get summary
      const summary = this.mcpTestingService.getTestSummary(testResult);
      console.log('Test Summary:', summary);
      // {
      //   passed: true,
      //   toolsTestedCount: 5,
      //   toolsPassedCount: 5,
      //   toolsFailedCount: 0,
      //   buildSuccess: true,
      //   cleanupSuccess: true,
      //   totalDurationMs: 45230
      // }

      return testResult;
    } finally {
      this.mcpTestingService.unregisterProgressCallback('my-test');
    }
  }
}
```

## Response Types

### TestProgressUpdate (Streamed)

```typescript
interface TestProgressUpdate {
  type: 'building' | 'starting' | 'testing' | 'testing_tool' | 'complete' | 'error' | 'cleanup';
  message: string;
  phase?: string;
  progress?: number; // 0-100
  toolName?: string;
  toolIndex?: number;
  totalTools?: number;
  timestamp: Date;
}
```

### McpServerTestResult (Final)

```typescript
interface McpServerTestResult {
  containerId: string;
  imageTag: string;
  buildSuccess: boolean;
  buildError?: string;
  buildDuration: number; // milliseconds
  toolsFound: number;
  toolsTested: number;
  toolsPassedCount: number;
  results: ToolTestResult[];
  overallSuccess: boolean;
  totalDuration: number; // milliseconds
  cleanupSuccess: boolean;
  cleanupErrors: string[];
  timestamp: Date;
}

interface ToolTestResult {
  toolName: string;
  success: boolean;
  executionTime: number; // milliseconds
  output?: any;
  error?: string;
  mcpCompliant: boolean;
  timestamp: Date;
}
```

## Error Handling

### Build Failures

```json
{
  "buildSuccess": false,
  "buildError": "npm ERR! code ERESOLVE\nnpm ERR! ERESOLVE unable to resolve dependency tree...",
  "buildDuration": 15230,
  "results": [],
  "overallSuccess": false,
  "cleanupErrors": []
}
```

### Tool Test Failures

```json
{
  "toolName": "analyze",
  "success": false,
  "error": "Tool response missing content field",
  "mcpCompliant": false,
  "executionTime": 245
}
```

### Cleanup Failures (Non-blocking)

```json
{
  "overallSuccess": true,
  "cleanupSuccess": false,
  "cleanupErrors": [
    "Failed to remove image: image in use",
    "Temp directory cleanup failed: permission denied"
  ]
}
```

## Performance Characteristics

### Typical Test Duration

- Docker Build: 30-60 seconds (first run), 10-15 seconds (cached)
- Container Start: 2-3 seconds
- Tool Testing: 0.5-2 seconds per tool
- Cleanup: 5-10 seconds
- **Total**: 40-90 seconds for full test cycle

### Resource Usage

- Disk: ~500MB per test (temporary files + Docker image)
- Memory: Host machine only (container limit: 512MB)
- CPU: Host machine only (container limit: 0.5 cores)
- Network: None (container has no network access)

## Testing in Development

### Manual Docker Testing

```bash
# Build MCP server Docker image
docker build -t test-mcp-server .

# Run with constraints
docker run --rm \
  --cpus="0.5" \
  --memory="512m" \
  --memory-swap="512m" \
  --network=none \
  --read-only \
  --cap-drop=ALL \
  test-mcp-server

# Test specific tool
echo '{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}' | \
  docker exec -i <container-id> node dist/index.js
```

### Unit Testing the Service

```typescript
import { Test } from '@nestjs/testing';
import { McpTestingService } from './mcp-testing.service';

describe('McpTestingService', () => {
  let service: McpTestingService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [McpTestingService],
    }).compile();

    service = module.get<McpTestingService>(McpTestingService);
  });

  it('should test MCP server successfully', async () => {
    const generatedCode: GeneratedCode = {
      mainFile: fs.readFileSync('test-fixtures/index.ts', 'utf8'),
      packageJson: fs.readFileSync('test-fixtures/package.json', 'utf8'),
      tsConfig: fs.readFileSync('test-fixtures/tsconfig.json', 'utf8'),
      supportingFiles: {},
      metadata: {
        tools: [{ name: 'test', description: 'Test tool', inputSchema: {} }],
        iteration: 1,
        serverName: 'test-server',
      },
    };

    const result = await service.testMcpServer(generatedCode, {
      timeout: 60,
      cleanup: true,
    });

    expect(result.overallSuccess).toBe(true);
    expect(result.toolsPassedCount).toEqual(result.toolsTested);
    expect(result.buildSuccess).toBe(true);
    expect(result.cleanupSuccess).toBe(true);
  });
});
```

## Troubleshooting

### Issue: Docker command not found

**Solution**: Ensure Docker is installed and running
```bash
docker --version
docker ps
```

### Issue: Build takes too long

**Solution**: Increase timeout or optimize dependencies
```typescript
await service.testMcpServer(code, { timeout: 300 }); // 5 minutes
```

### Issue: Container exits immediately

**Check logs**:
```bash
docker logs <container-id>
```

**Common causes**:
- Missing MCP dependencies in package.json
- Invalid TypeScript in generated code
- Missing server.connect(transport) call in async main() function

### Issue: Tools/call returns error

**Check**:
1. Tool is listed in tools/list response
2. Input parameters match schema
3. Tool implementation doesn't throw exceptions

## Best Practices

1. **Always set cleanup: true** - Prevents Docker resource accumulation
2. **Use reasonable timeouts** - 120s for build, 5s per tool
3. **Monitor cleanup errors** - Log and alert on persistent cleanup failures
4. **Stream progress to UI** - Better UX than waiting for result
5. **Validate generated code** - Before testing, ensure syntax is valid
6. **Set appropriate resource limits** - 512MB memory is sufficient for most tools

## Future Enhancements

- Parallel tool testing (within CPU limits)
- Custom test scenarios (fixtures, mock data)
- Performance benchmarking
- Failure recovery with regeneration
- Container health monitoring
- Test result caching
- Distributed testing across multiple Docker daemons
