# nginx-ingress Controller

The nginx-ingress controller routes external traffic to MCP server pods.

## Installation

```bash
./install.sh
```

## Configuration

### values.yaml

Key configurations:
- **replicaCount**: 2 replicas for high availability
- **default-ssl-certificate**: Uses the wildcard certificate from mcp-servers namespace
- **metrics**: Enabled for Prometheus scraping

### Cloud Provider Annotations

Edit `values.yaml` to add cloud-specific annotations:

**AWS (Network Load Balancer):**
```yaml
controller:
  service:
    annotations:
      service.beta.kubernetes.io/aws-load-balancer-type: nlb
      service.beta.kubernetes.io/aws-load-balancer-cross-zone-load-balancing-enabled: "true"
```

**GCP:**
```yaml
controller:
  service:
    annotations:
      cloud.google.com/load-balancer-type: External
```

**Azure:**
```yaml
controller:
  service:
    annotations:
      service.beta.kubernetes.io/azure-load-balancer-health-probe-request-path: /healthz
```

## Verification

```bash
# Check pods are running
kubectl get pods -n ingress-nginx

# Check service has external IP
kubectl get svc -n ingress-nginx

# Check ingress class
kubectl get ingressclass
```

## Uninstallation

```bash
helm uninstall ingress-nginx -n ingress-nginx
kubectl delete namespace ingress-nginx
```
