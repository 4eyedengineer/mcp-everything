# MCP Everything Runbooks

This directory contains runbooks for operational alerts in the MCP Everything platform.

## Alert Overview

| Alert | Severity | Team | Runbook |
|-------|----------|------|---------|
| HighGenerationErrorRate | Critical | Backend | [Link](./high-generation-error-rate.md) |
| SlowGenerations | Warning | Backend | [Link](./slow-generations.md) |
| NoGenerations | Warning | Backend | [Link](./no-generations.md) |
| HighApiErrorRate | Critical | Backend | [Link](./high-api-error-rate.md) |
| HighApiLatency | Warning | Backend | [Link](./high-api-latency.md) |
| HighMemoryUsage | Warning | Infrastructure | [Link](./high-memory-usage.md) |
| HighCpuUsage | Warning | Infrastructure | [Link](./high-cpu-usage.md) |
| HighEventLoopLag | Warning | Backend | [Link](./high-event-loop-lag.md) |
| ProcessRestarted | Info | Infrastructure | [Link](./process-restarted.md) |
| LowGenerationSuccessRate | Warning | Backend | [Link](./low-generation-success-rate.md) |
| HighDeploymentFailureRate | Warning | Infrastructure | [Link](./high-deployment-failure-rate.md) |
| HighApiRequestRate | Info | Backend | [Link](./high-api-request-rate.md) |

## Quick Reference

### Common Commands

```bash
# Get pod status
kubectl get pods -n mcp-everything

# View recent logs
kubectl logs -n mcp-everything deployment/mcp-backend --tail=500

# Check resource usage
kubectl top pods -n mcp-everything

# Rolling restart
kubectl rollout restart deployment/mcp-backend -n mcp-everything

# Health check
kubectl exec -n mcp-everything deployment/mcp-backend -- curl -s localhost:3000/health
```

### Dashboard Links

- [System Overview](https://grafana.example.com/d/mcp-overview)
- [Generation Pipeline](https://grafana.example.com/d/mcp-generation)
- [Business Metrics](https://grafana.example.com/d/mcp-business)
- [Infrastructure](https://grafana.example.com/d/mcp-infrastructure)

### External Status Pages

- [Anthropic Status](https://status.anthropic.com)
- [GitHub Status](https://www.githubstatus.com)
- [PostgreSQL Cloud Status](Check your provider)

## Escalation Paths

| Severity | Response Time | Escalation |
|----------|---------------|------------|
| Critical | 15 min | Page on-call, notify team lead |
| Warning | 1 hour | Alert on-call, track in Slack |
| Info | Next business day | Review in daily standup |

## Adding New Runbooks

When adding a new alert:

1. Create the alert rule in `k8s/monitoring/prometheus-rules.yaml`
2. Create a runbook in this directory following the template
3. Update this README with the new alert
4. Test the alert fires correctly
5. Review with the on-call team

## Runbook Template

Use this template for new runbooks:

```markdown
# Alert Name

## Alert Details

| Property | Value |
|----------|-------|
| **Alert Name** | AlertName |
| **Severity** | Critical/Warning/Info |
| **Team** | Backend/Infrastructure |
| **Threshold** | condition |

## Description

What this alert means.

## Impact

- Impact 1
- Impact 2

## Investigation Steps

### 1. Step Name

Description and commands.

## Common Causes

| Cause | Symptoms | Solution |
|-------|----------|----------|

## Remediation

### Immediate Actions

### Long-term Actions

## Related Dashboards

## Escalation
```
