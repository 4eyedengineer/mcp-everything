# High Memory Usage

## Alert Details

| Property | Value |
|----------|-------|
| **Alert Name** | HighMemoryUsage |
| **Severity** | Warning |
| **Team** | Infrastructure |
| **Threshold** | > 1.5 GB for 10 minutes |

## Description

This alert fires when the backend process resident memory exceeds 1.5 GB for a sustained 10-minute period.

## Impact

- Risk of OOMKilled pods
- Potential service degradation
- Increased GC pressure and latency
- Risk of node eviction

## Investigation Steps

### 1. Check Current Memory Usage

```bash
# Pod memory usage
kubectl top pods -n mcp-everything

# Detailed memory stats
kubectl exec -n mcp-everything deployment/mcp-backend -- \
  node -e "console.log(JSON.stringify(process.memoryUsage(), null, 2))"
```

### 2. Check Heap Statistics

In Grafana's Infrastructure dashboard, examine:
- Heap Used vs Heap Total
- Memory growth over time

### 3. Check for Memory Leaks

```bash
# Look for patterns in memory growth
kubectl logs -n mcp-everything deployment/mcp-backend | \
  grep -E "heap|memory|gc"
```

### 4. Review Recent Changes

```bash
# Check recent deployments
kubectl rollout history deployment/mcp-backend -n mcp-everything

# Check for new features that may be memory-intensive
git log --oneline -20
```

## Common Causes

| Cause | Symptoms | Solution |
|-------|----------|----------|
| Memory leak | Continuous growth | Identify leak, deploy fix |
| Large payloads | Spike during specific operations | Stream large data, add limits |
| Unbounded caches | Growth over time | Add cache eviction policies |
| Event listener leaks | Many active handles | Clean up event listeners |

## Remediation

### Immediate Actions

1. **Trigger garbage collection** (temporary relief):
   ```bash
   kubectl exec -n mcp-everything deployment/mcp-backend -- \
     kill -SIGUSR2 1  # May need to enable --expose-gc
   ```

2. **Rolling restart**:
   ```bash
   kubectl rollout restart deployment/mcp-backend -n mcp-everything
   ```

3. **Scale horizontally** (distribute load):
   ```bash
   kubectl scale deployment/mcp-backend -n mcp-everything --replicas=3
   ```

### Long-term Actions

1. Add memory profiling in staging
2. Implement request/response size limits
3. Add bounded caches with TTL
4. Review and fix event listener cleanup
5. Consider implementing memory alerts at application level

## Memory Limits Configuration

Current configuration (check actual values):

```yaml
resources:
  requests:
    memory: "512Mi"
  limits:
    memory: "2Gi"
```

Recommended adjustments based on usage patterns.

## Related Dashboards

- [Infrastructure Dashboard](https://grafana.example.com/d/mcp-infrastructure)
- [System Overview Dashboard](https://grafana.example.com/d/mcp-overview)

## Escalation

If memory usage exceeds 90% of limits:

1. Page infrastructure on-call
2. Prepare for potential OOM events
3. Consider emergency scaling
