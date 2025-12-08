# High API Latency

## Alert Details

| Property | Value |
|----------|-------|
| **Alert Name** | HighApiLatency |
| **Severity** | Warning |
| **Team** | Backend |
| **Threshold** | P95 > 2 seconds for 5 minutes |

## Description

This alert fires when the 95th percentile API response time exceeds 2 seconds for a sustained 5-minute period.

## Impact

- Degraded user experience
- Frontend timeout errors
- Potential cascade effects on dependent systems
- Lower conversion rates

## Investigation Steps

### 1. Identify Slow Endpoints

In Grafana, check the "Response Latency Percentiles" and "Request Rate by Endpoint" panels to identify which endpoints are slow.

### 2. Check Database Queries

```bash
# Check for slow queries
kubectl exec -n mcp-everything deployment/mcp-backend -- \
  psql $DATABASE_URL -c "SELECT pid, now() - pg_stat_activity.query_start AS duration, query
    FROM pg_stat_activity
    WHERE (now() - pg_stat_activity.query_start) > interval '1 second';"
```

### 3. Check External API Calls

```bash
# Check for slow external calls in logs
kubectl logs -n mcp-everything deployment/mcp-backend | \
  grep -E "duration.*[0-9]{4,}ms" | tail -20
```

### 4. Check Resource Utilization

```bash
kubectl top pods -n mcp-everything
kubectl top nodes
```

## Common Causes

| Cause | Symptoms | Solution |
|-------|----------|----------|
| Slow database queries | High DB latency | Add indexes, optimize queries |
| External API slowness | High external call duration | Add caching, implement timeouts |
| Resource starvation | High CPU/memory | Scale up, optimize code |
| Network issues | Variable latency | Check network policies, DNS |

## Remediation

### Immediate Actions

1. **Scale horizontally**:
   ```bash
   kubectl scale deployment/mcp-backend -n mcp-everything --replicas=3
   ```

2. **Check for blocking operations**:
   ```bash
   kubectl logs -n mcp-everything deployment/mcp-backend | \
     grep -E "blocked|waiting|timeout"
   ```

### Long-term Actions

1. Add database query caching (Redis)
2. Implement connection pooling
3. Add APM tracing for bottleneck identification
4. Review and optimize N+1 queries
5. Implement request timeouts

## Latency Targets

| Endpoint Category | P50 Target | P95 Target | P99 Target |
|-------------------|------------|------------|------------|
| Health checks | < 10ms | < 50ms | < 100ms |
| Simple reads | < 50ms | < 200ms | < 500ms |
| Complex queries | < 200ms | < 1s | < 2s |
| Generation start | < 500ms | < 2s | < 5s |

## Related Dashboards

- [System Overview Dashboard](https://grafana.example.com/d/mcp-overview)
- [Infrastructure Dashboard](https://grafana.example.com/d/mcp-infrastructure)

## Escalation

If P95 latency exceeds 5 seconds:

1. Alert backend team
2. Check for degraded external services
3. Consider enabling read replicas for database
