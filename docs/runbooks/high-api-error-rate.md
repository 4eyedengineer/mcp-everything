# High API Error Rate

## Alert Details

| Property | Value |
|----------|-------|
| **Alert Name** | HighApiErrorRate |
| **Severity** | Critical |
| **Team** | Backend |
| **Threshold** | > 5% 5xx responses for 5 minutes |

## Description

This alert fires when more than 5% of API requests result in 5xx server errors over a 5-minute period.

## Impact

- Users experiencing errors across the platform
- Potential data inconsistency
- Revenue impact from blocked operations
- Brand reputation damage

## Investigation Steps

### 1. Identify Affected Endpoints

```bash
# Check which endpoints are failing
kubectl logs -n mcp-everything deployment/mcp-backend --tail=1000 | \
  grep -E "status\":5[0-9][0-9]" | \
  jq -r '.endpoint' | sort | uniq -c | sort -rn
```

### 2. Check Error Details

```bash
# Get detailed error messages
kubectl logs -n mcp-everything deployment/mcp-backend --tail=500 | \
  grep -E "error|Error|ERROR" | tail -50
```

### 3. Check Pod Health

```bash
# Pod status
kubectl get pods -n mcp-everything -o wide

# Recent events
kubectl get events -n mcp-everything --sort-by='.lastTimestamp' | tail -20
```

### 4. Verify Dependencies

```bash
# Health check
kubectl exec -n mcp-everything deployment/mcp-backend -- curl -s localhost:3000/health | jq

# Database connectivity
kubectl exec -n mcp-everything deployment/mcp-backend -- \
  curl -s localhost:3000/health/database | jq
```

## Common Causes

| Cause | Symptoms | Solution |
|-------|----------|----------|
| Database connection pool exhausted | Connection timeout errors | Restart pods, tune pool size |
| Unhandled exceptions | Stack traces in logs | Deploy hotfix, add error handling |
| Memory issues | OOMKilled events | Increase limits, fix memory leaks |
| External service failures | Upstream timeout errors | Implement circuit breakers |

## Remediation

### Immediate Actions

1. **Rolling restart** (clears bad state):
   ```bash
   kubectl rollout restart deployment/mcp-backend -n mcp-everything
   ```

2. **Check recent deployments**:
   ```bash
   kubectl rollout history deployment/mcp-backend -n mcp-everything
   ```

3. **Rollback if needed**:
   ```bash
   kubectl rollout undo deployment/mcp-backend -n mcp-everything
   ```

### Long-term Actions

1. Implement comprehensive error handling
2. Add circuit breakers for external calls
3. Improve logging with correlation IDs
4. Add integration tests for error scenarios

## Error Response Codes Reference

| Code | Meaning | Common Cause |
|------|---------|--------------|
| 500 | Internal Server Error | Unhandled exception |
| 502 | Bad Gateway | Upstream service down |
| 503 | Service Unavailable | Overloaded, maintenance |
| 504 | Gateway Timeout | Upstream timeout |

## Related Dashboards

- [System Overview Dashboard](https://grafana.example.com/d/mcp-overview)
- [Infrastructure Dashboard](https://grafana.example.com/d/mcp-infrastructure)

## Escalation

1. **> 10% error rate**: Page on-call immediately
2. **> 25% error rate**: Initiate incident response
3. **> 50% error rate**: Consider full service restart
