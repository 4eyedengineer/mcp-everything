#!/bin/bash
set -euo pipefail

# cert-manager installation script
# Installs cert-manager for automatic TLS certificate management

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAMESPACE="cert-manager"
RELEASE_NAME="cert-manager"
CHART_VERSION="v1.14.2"  # Pinned for reproducibility

echo "=== Installing cert-manager ==="

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
echo "Adding jetstack Helm repository..."
helm repo add jetstack https://charts.jetstack.io
helm repo update

# Check if already installed
if helm status "$RELEASE_NAME" -n "$NAMESPACE" &> /dev/null; then
    echo "cert-manager is already installed. Upgrading..."
    ACTION="upgrade"
else
    echo "Installing cert-manager..."
    ACTION="install"
fi

# Install/Upgrade cert-manager
helm "$ACTION" "$RELEASE_NAME" jetstack/cert-manager \
    --namespace "$NAMESPACE" \
    --create-namespace \
    --version "$CHART_VERSION" \
    --values "$SCRIPT_DIR/values.yaml" \
    --wait \
    --timeout 5m

echo ""
echo "=== cert-manager installation complete ==="
echo ""

# Verify installation
echo "Verifying cert-manager pods..."
kubectl get pods -n "$NAMESPACE"

echo ""
echo "Verify webhook is working:"
echo "  kubectl get apiservices v1.cert-manager.io"
echo ""
echo "Next steps:"
echo "  1. Create DNS provider secret (see ../04-certificates/)"
echo "  2. Apply ClusterIssuer"
echo "  3. Apply wildcard Certificate"
