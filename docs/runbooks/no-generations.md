# No Generations

## Alert Details

| Property | Value |
|----------|-------|
| **Alert Name** | NoGenerations |
| **Severity** | Warning |
| **Team** | Backend |
| **Threshold** | 0 generations for 1 hour |

## Description

This alert fires when no MCP server generations have been recorded in the last hour. This could indicate a stuck pipeline, no traffic, or a metrics collection issue.

## Impact

- Complete loss of core functionality
- Users cannot generate new MCP servers
- Potential revenue loss
- May indicate broader system failure

## Investigation Steps

### 1. Verify Metrics Collection

```bash
# Check if metrics endpoint is working
kubectl exec -n mcp-everything deployment/mcp-backend -- \
  curl -s localhost:3000/metrics | grep mcp_generation
```

### 2. Check Service Health

```bash
# Health check
kubectl exec -n mcp-everything deployment/mcp-backend -- \
  curl -s localhost:3000/health | jq

# Pod status
kubectl get pods -n mcp-everything
```

### 3. Check for Traffic

```bash
# Check for incoming requests
kubectl logs -n mcp-everything deployment/mcp-backend --tail=500 | \
  grep -E "POST.*/chat|POST.*/generate"
```

### 4. Check External Dependencies

```bash
# Verify Anthropic API connectivity
kubectl exec -n mcp-everything deployment/mcp-backend -- \
  curl -s -o /dev/null -w "%{http_code}" https://api.anthropic.com

# Verify GitHub API connectivity
kubectl exec -n mcp-everything deployment/mcp-backend -- \
  curl -s -o /dev/null -w "%{http_code}" https://api.github.com
```

## Common Causes

| Cause | Symptoms | Solution |
|-------|----------|----------|
| No user traffic | Low request count | Marketing, check frontend |
| Stuck pipeline | Requests received but no generations | Restart, check queues |
| External API down | API connection errors | Check status pages, wait |
| Metrics issue | Service working, metrics not recording | Fix metrics collection |

## Remediation

### Immediate Actions

1. **Test generation manually**:

   The standalone `POST /generate-mcp` debug endpoint has been removed. All
   generations now go through the authenticated chat message flow, which
   requires a valid JWT (obtained via `POST /api/v1/auth/login` or
   `/api/v1/auth/register`) and an existing session:

   ```bash
   # 1. Log in to get a JWT
   TOKEN=$(curl -s -X POST http://localhost:3000/api/v1/auth/login \
     -H "Content-Type: application/json" \
     -d '{"email": "you@example.com", "password": "..."}' | jq -r '.accessToken')

   # 2. Send a chat message describing what to generate — this triggers the
   #    same GenerationPipeline (analyzeIntent -> research -> planTools ->
   #    clarify -> refine -> persist) that manual generation used to hit
   #    directly.
   curl -X POST http://localhost:3000/api/chat/message \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer $TOKEN" \
     -d '{"sessionId": "debug-session-1", "message": "Generate an MCP server from https://github.com/example/test-repo"}'

   # 3. Watch progress via the SSE stream (requires a stream ticket; see
   #    POST /api/chat/stream-ticket and GET /api/chat/stream/:sessionId
   #    in packages/backend/src/chat/chat.controller.ts).
   ```

2. **Restart if stuck**:
   ```bash
   kubectl rollout restart deployment/mcp-backend -n mcp-everything
   ```

### Verification Steps

1. Submit a test generation request
2. Verify metrics are recorded
3. Check Grafana dashboard updates

### Long-term Actions

1. Implement synthetic monitoring (scheduled test generations)
2. Add heartbeat metrics
3. Improve logging around generation lifecycle
4. Add generation queue visibility

## Differentiating Causes

| Check | Result | Interpretation |
|-------|--------|----------------|
| Request logs present | No | No traffic (expected or not) |
| Request logs present | Yes | Pipeline stuck |
| Metrics endpoint works | No | Metrics collection issue |
| Health check passes | No | Service down |

## Related Dashboards

- [Generation Pipeline Dashboard](https://grafana.example.com/d/mcp-generation)
- [System Overview Dashboard](https://grafana.example.com/d/mcp-overview)

## Escalation

If no generations after 2 hours:

1. Alert product team (may be expected, e.g., weekend)
2. Check for broader outage
3. Review recent changes
