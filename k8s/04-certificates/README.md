# SSL Certificates

This directory contains the ClusterIssuer and Certificate resources for automatic TLS certificate management.

## Overview

- **ClusterIssuer**: Configures Let's Encrypt with DNS-01 challenge (required for wildcards)
- **Wildcard Certificate**: Covers `*.mcp.yourdomain.com` and `mcp.yourdomain.com`
- **Cloudflare Secret**: Template for DNS provider API credentials

## Setup Instructions

### 1. Create Cloudflare API Token

1. Go to [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens)
2. Click "Create Token"
3. Use the "Edit zone DNS" template, or create custom with:
   - **Permissions**: Zone > DNS > Edit
   - **Zone Resources**: Include > Specific zone > your domain
4. Copy the generated token (shown only once)

### 2. Create the Secret

```bash
# Copy the example file
cp cloudflare-secret.yaml.example cloudflare-secret.yaml

# Edit and replace YOUR_API_TOKEN_HERE with your actual token
nano cloudflare-secret.yaml

# Apply the secret
kubectl apply -f cloudflare-secret.yaml
```

### 3. Update Domain in Manifests

Edit the following files and replace `yourdomain.com` with your actual domain:
- `cluster-issuer.yaml` - Update email address
- `wildcard-certificate.yaml` - Update domain names

### 4. Apply the Resources

```bash
# Apply ClusterIssuer first
kubectl apply -f cluster-issuer.yaml

# Then apply the Certificate
kubectl apply -f wildcard-certificate.yaml
```

## Verification

```bash
# Check ClusterIssuer is ready
kubectl get clusterissuer letsencrypt-prod

# Check Certificate status
kubectl get certificate -n mcp-servers

# Check certificate details
kubectl describe certificate mcp-wildcard-cert -n mcp-servers

# Check the actual secret (certificate data)
kubectl get secret mcp-wildcard-tls -n mcp-servers
```

## Using Staging for Testing

Before using production Let's Encrypt (which has rate limits), test with staging:

1. In `wildcard-certificate.yaml`, change issuerRef to:
   ```yaml
   issuerRef:
     name: letsencrypt-staging
     kind: ClusterIssuer
   ```

2. Apply and verify it works
3. Delete the staging certificate
4. Switch back to `letsencrypt-prod`

## Troubleshooting

### Certificate stuck in pending

Check the Certificate status:
```bash
kubectl describe certificate mcp-wildcard-cert -n mcp-servers
```

Check CertificateRequest:
```bash
kubectl get certificaterequest -n mcp-servers
kubectl describe certificaterequest <name> -n mcp-servers
```

Check Challenge (for DNS-01):
```bash
kubectl get challenge -n mcp-servers
kubectl describe challenge <name> -n mcp-servers
```

### DNS challenge failing

Common issues:
1. **Wrong API token**: Verify token has correct permissions
2. **Wrong zone**: Ensure the token covers your domain's zone
3. **Propagation delay**: DNS changes can take time to propagate

Check cert-manager logs:
```bash
kubectl logs -n cert-manager -l app=cert-manager -f
```

## Alternative DNS Providers

### AWS Route53

Replace the Cloudflare solver in `cluster-issuer.yaml`:

```yaml
solvers:
  - dns01:
      route53:
        region: us-east-1
        # Use IAM role (recommended) or access keys
        accessKeyIDSecretRef:
          name: route53-credentials
          key: access-key-id
        secretAccessKeySecretRef:
          name: route53-credentials
          key: secret-access-key
```

### Google Cloud DNS

```yaml
solvers:
  - dns01:
      cloudDNS:
        project: your-gcp-project-id
        serviceAccountSecretRef:
          name: clouddns-credentials
          key: key.json
```

### DigitalOcean

```yaml
solvers:
  - dns01:
      digitalocean:
        tokenSecretRef:
          name: digitalocean-dns
          key: access-token
```

See [cert-manager DNS01 documentation](https://cert-manager.io/docs/configuration/acme/dns01/) for more providers.
