#!/bin/bash
set -euo pipefail

# nginx-ingress controller installation script
# Installs nginx-ingress using Helm with production-ready configuration

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAMESPACE="ingress-nginx"
RELEASE_NAME="ingress-nginx"
CHART_VERSION="4.9.0"  # Pinned for reproducibility

echo "=== Installing nginx-ingress controller ==="

# Check prerequisites
if ! command -v helm &> /dev/null; then
    echo "Error: helm is not installed"
    exit 1
fi

if ! command -v kubectl &> /dev/null; then
    echo "Error: kubectl is not installed"
    exit 1
fi

# Add Helm repository
echo "Adding ingress-nginx Helm repository..."
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo update

# Check if already installed
if helm status "$RELEASE_NAME" -n "$NAMESPACE" &> /dev/null; then
    echo "nginx-ingress is already installed. Upgrading..."
    ACTION="upgrade"
else
    echo "Installing nginx-ingress..."
    ACTION="install"
fi

# Install/Upgrade nginx-ingress
helm "$ACTION" "$RELEASE_NAME" ingress-nginx/ingress-nginx \
    --namespace "$NAMESPACE" \
    --create-namespace \
    --version "$CHART_VERSION" \
    --values "$SCRIPT_DIR/values.yaml" \
    --wait \
    --timeout 5m

echo ""
echo "=== nginx-ingress installation complete ==="
echo ""

# Wait for LoadBalancer IP
echo "Waiting for LoadBalancer IP..."
for i in {1..60}; do
    LB_IP=$(kubectl get svc -n "$NAMESPACE" ingress-nginx-controller -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)
    LB_HOSTNAME=$(kubectl get svc -n "$NAMESPACE" ingress-nginx-controller -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || true)

    if [[ -n "$LB_IP" ]]; then
        echo "LoadBalancer IP: $LB_IP"
        echo ""
        echo "Configure your DNS:"
        echo "  *.mcp.yourdomain.com -> $LB_IP"
        break
    elif [[ -n "$LB_HOSTNAME" ]]; then
        echo "LoadBalancer Hostname: $LB_HOSTNAME"
        echo ""
        echo "Configure your DNS:"
        echo "  *.mcp.yourdomain.com -> CNAME -> $LB_HOSTNAME"
        break
    fi

    if [[ $i -eq 60 ]]; then
        echo "Warning: LoadBalancer IP not yet assigned. Check your cloud provider."
        echo "Run: kubectl get svc -n $NAMESPACE ingress-nginx-controller"
    fi

    sleep 5
done

echo ""
echo "Verify installation:"
echo "  kubectl get pods -n $NAMESPACE"
echo "  kubectl get svc -n $NAMESPACE"
