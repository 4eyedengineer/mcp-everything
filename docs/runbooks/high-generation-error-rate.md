# High Generation Error Rate

## Alert Details

| Property | Value |
|----------|-------|
| **Alert Name** | HighGenerationErrorRate |
| **Severity** | Critical |
| **Team** | Backend |
| **Threshold** | > 0.1 errors/second for 5 minutes |

## Description

This alert fires when the MCP server generation error rate exceeds 0.1 errors per second sustained over 5 minutes. This indicates a systemic issue with the generation pipeline.

## Impact

- Users cannot generate new MCP servers
- Revenue impact from blocked conversions
- Potential backlog of failed generation requests

## Investigation Steps

### 1. Check Recent Logs

```bash
kubectl logs -n mcp-everything deployment/mcp-backend --tail=500 | grep -i error
```

### 2. Check Error Types Distribution

In Grafana, navigate to the "MCP Everything - Generation Pipeline" dashboard and examine the "Errors by Type" pie chart to identify the most common error type.

### 3. Check Infrastructure

```bash
# Check pod status
kubectl get pods -n mcp-everything

# Check resource usage
kubectl top pods -n mcp-everything
```

### 4. Verify External Dependencies

- **Anthropic API**: Check API status at https://status.anthropic.com
- **GitHub API**: Check rate limits and API status
- **Database**: Verify PostgreSQL connectivity

```bash
kubectl exec -n mcp-everything deployment/mcp-backend -- curl -s localhost:3000/health
```

## Common Causes

| Cause | Symptoms | Solution |
|-------|----------|----------|
| Anthropic API issues | `anthropic_api_error` in logs | Wait for API recovery, implement retry logic |
| Database connection issues | `database_error` in logs | Check PostgreSQL, restore connections |
| Memory exhaustion | OOMKilled pods | Increase memory limits, optimize code |
| Invalid input handling | `validation_error` in logs | Review input validation, add guards |

## Remediation

### Immediate Actions

1. **Scale Up** (if resource constrained):
   ```bash
   kubectl scale deployment/mcp-backend -n mcp-everything --replicas=3
   ```

2. **Restart Pods** (if stuck state):
   ```bash
   kubectl rollout restart deployment/mcp-backend -n mcp-everything
   ```

### Long-term Actions

1. Review and improve error handling in generation pipeline
2. Add circuit breakers for external API calls
3. Implement request validation at API gateway level
4. Add rate limiting to prevent cascade failures

## Related Dashboards

- [Generation Pipeline Dashboard](https://grafana.example.com/d/mcp-generation)
- [System Overview Dashboard](https://grafana.example.com/d/mcp-overview)

## Escalation

If the issue persists after following this runbook:

1. Page on-call engineer via PagerDuty
2. Create incident in incident management system
3. Notify stakeholders via #mcp-incidents Slack channel
