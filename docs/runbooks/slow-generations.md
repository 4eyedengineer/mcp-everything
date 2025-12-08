# Slow Generations

## Alert Details

| Property | Value |
|----------|-------|
| **Alert Name** | SlowGenerations |
| **Severity** | Warning |
| **Team** | Backend |
| **Threshold** | P95 > 300 seconds for 10 minutes |

## Description

This alert fires when the 95th percentile of MCP server generation time exceeds 5 minutes (300 seconds) for a sustained 10-minute period.

## Impact

- Degraded user experience
- Timeout errors for users
- Resource contention in the system
- Potential cascading slowdowns

## Investigation Steps

### 1. Identify Slow Generation Types

Check which source types are causing slow generations in Grafana's "Generation Duration by Source Type" panel.

### 2. Check System Resources

```bash
# Check CPU and memory
kubectl top pods -n mcp-everything

# Check for resource throttling
kubectl describe pods -n mcp-everything | grep -A5 "Resources:"
```

### 3. Check External API Latency

```bash
# Check Anthropic API response times in logs
kubectl logs -n mcp-everything deployment/mcp-backend | grep "anthropic" | grep "duration"
```

### 4. Database Performance

```bash
# Check for slow queries
kubectl exec -n mcp-everything deployment/mcp-backend -- \
  psql $DATABASE_URL -c "SELECT * FROM pg_stat_activity WHERE state = 'active';"
```

## Common Causes

| Cause | Symptoms | Solution |
|-------|----------|----------|
| Large repository analysis | GitHub source generations slow | Implement chunking, add timeouts |
| Anthropic API latency | High `anthropic_api_duration` | Check API status, implement caching |
| Database bottleneck | High DB query times | Optimize queries, add indexes |
| Memory pressure | High memory usage | Increase limits, optimize memory usage |

## Remediation

### Immediate Actions

1. **Check for runaway generations**:
   ```bash
   kubectl logs -n mcp-everything deployment/mcp-backend | grep "generation_id" | tail -20
   ```

2. **Scale horizontally**:
   ```bash
   kubectl scale deployment/mcp-backend -n mcp-everything --replicas=3
   ```

### Long-term Actions

1. Implement generation timeout at 5 minutes
2. Add progress checkpoints for large generations
3. Cache API analysis results
4. Implement async generation with status polling

## Performance Targets

| Percentile | Target | Current |
|------------|--------|---------|
| P50 | < 60s | Check dashboard |
| P90 | < 180s | Check dashboard |
| P95 | < 300s | Check dashboard |
| P99 | < 600s | Check dashboard |

## Related Dashboards

- [Generation Pipeline Dashboard](https://grafana.example.com/d/mcp-generation)
- [Infrastructure Dashboard](https://grafana.example.com/d/mcp-infrastructure)

## Escalation

If P95 generation time exceeds 10 minutes:

1. Alert backend team lead
2. Consider temporarily disabling new generation requests
3. Prioritize investigation of root cause
