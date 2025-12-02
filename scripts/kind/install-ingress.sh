#!/bin/bash
# Install nginx-ingress controller for KinD
set -e

echo "==> Installing nginx-ingress controller for KinD..."

# Apply KinD-specific nginx-ingress manifest
# This uses the official KinD ingress-nginx deployment
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml

echo "==> Waiting for ingress-nginx controller to be ready..."
kubectl wait --namespace ingress-nginx \
    --for=condition=ready pod \
    --selector=app.kubernetes.io/component=controller \
    --timeout=180s

echo "==> nginx-ingress controller installed successfully!"
echo ""
echo "Ingress is now available at:"
echo "  HTTP:  http://localhost:80"
echo "  HTTPS: https://localhost:443"
