# Kubernetes Infrastructure for MCP Everything

This directory contains installation scripts and configuration for the Kubernetes infrastructure required to host MCP servers.

## Prerequisites

- Kubernetes cluster (v1.25+)
- `kubectl` configured with cluster access
- `helm` 3.x installed
- Domain with DNS access (Cloudflare recommended)
- DNS provider API credentials for Let's Encrypt DNS-01 challenge

## Directory Structure

```
k8s/
├── README.md                    # This file
├── install.sh                   # Master installation script
├── 02-ingress-nginx/            # nginx-ingress controller
├── 03-cert-manager/             # cert-manager for SSL
├── 04-certificates/             # ClusterIssuer and secret templates
└── 05-test/                     # Verification resources
```

## Quick Start

```bash
# Install everything with one command
./install.sh --domain yourdomain.com --email admin@yourdomain.com

# Or install components individually:
./02-ingress-nginx/install.sh
./03-cert-manager/install.sh
kubectl apply -f 04-certificates/
./05-test/verify.sh
```

## Installation Order

1. **Namespace & Base Resources** - Already set up via `mcp-server-deployments/base/`
2. **nginx-ingress** - Ingress controller for routing traffic
3. **cert-manager** - Automatic certificate management
4. **Certificates** - ClusterIssuer and wildcard certificate
5. **Verification** - Test that everything works

## DNS Configuration

Before installing certificates, configure your DNS:

### Cloudflare (Recommended)

1. Log into Cloudflare Dashboard
2. Create an API token with `Zone:DNS:Edit` permission
3. Create wildcard DNS record:
   ```
   *.mcp.yourdomain.com -> <Ingress Controller LoadBalancer IP>
   ```
4. Create the Cloudflare secret:
   ```bash
   cp 04-certificates/cloudflare-secret.yaml.example 04-certificates/cloudflare-secret.yaml
   # Edit cloudflare-secret.yaml with your API token
   kubectl apply -f 04-certificates/cloudflare-secret.yaml
   ```

### Getting the LoadBalancer IP

After installing nginx-ingress:
```bash
kubectl get svc -n ingress-nginx ingress-nginx-controller -o jsonpath='{.status.loadBalancer.ingress[0].ip}'
```

## Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `DOMAIN` | Your base domain | `yourdomain.com` |
| `ACME_EMAIL` | Email for Let's Encrypt notifications | `admin@yourdomain.com` |

## Verification

After installation, verify everything works:

```bash
# Check nginx-ingress is running
kubectl get pods -n ingress-nginx

# Check cert-manager is running
kubectl get pods -n cert-manager

# Check certificate is issued
kubectl get certificate -n mcp-servers

# Test HTTPS (should return 404 - no backend yet)
curl -v https://test.mcp.yourdomain.com
```

## Troubleshooting

### Certificate not issuing

Check cert-manager logs:
```bash
kubectl logs -n cert-manager -l app=cert-manager
```

Check certificate status:
```bash
kubectl describe certificate mcp-wildcard-cert -n mcp-servers
```

### DNS challenge failing

Ensure your Cloudflare API token has the correct permissions and the secret is created in the `cert-manager` namespace.

### Ingress not working

Check ingress controller logs:
```bash
kubectl logs -n ingress-nginx -l app.kubernetes.io/name=ingress-nginx
```

## Related Resources

- [HOSTING_ARCHITECTURE.md](../docs/HOSTING_ARCHITECTURE.md) - Full hosting architecture
- [mcp-server-deployments/](../mcp-server-deployments/) - GitOps manifests for MCP servers
