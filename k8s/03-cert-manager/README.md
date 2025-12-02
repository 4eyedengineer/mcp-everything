# cert-manager

cert-manager automates TLS certificate management, including Let's Encrypt certificate issuance and renewal.

## Installation

```bash
./install.sh
```

## How It Works

1. cert-manager watches for Certificate resources
2. When a Certificate is created, it requests a certificate from the configured Issuer
3. For wildcard certificates, DNS-01 challenge is used (HTTP-01 doesn't support wildcards)
4. Certificates are automatically renewed before expiry (default: 30 days before)

## Verification

```bash
# Check pods
kubectl get pods -n cert-manager

# Check CRDs are installed
kubectl get crd | grep cert-manager

# Check webhook is working
kubectl get apiservices v1.cert-manager.io
```

## Troubleshooting

### Certificate not issuing

Check cert-manager logs:
```bash
kubectl logs -n cert-manager -l app=cert-manager -f
```

Check certificate status:
```bash
kubectl describe certificate <cert-name> -n <namespace>
```

Check certificate request:
```bash
kubectl get certificaterequest -A
kubectl describe certificaterequest <request-name> -n <namespace>
```

### DNS-01 challenge failing

Check challenge status:
```bash
kubectl get challenges -A
kubectl describe challenge <challenge-name> -n <namespace>
```

Common issues:
- Incorrect API token/credentials
- Wrong DNS zone configured
- API token missing required permissions

### Webhook errors

If you see webhook errors:
```bash
# Check webhook pod
kubectl get pods -n cert-manager -l app=webhook

# Check webhook logs
kubectl logs -n cert-manager -l app=webhook
```

## Uninstallation

```bash
helm uninstall cert-manager -n cert-manager
kubectl delete namespace cert-manager

# Optionally remove CRDs (this will delete all certificates!)
kubectl delete -f https://github.com/cert-manager/cert-manager/releases/download/v1.14.2/cert-manager.crds.yaml
```
