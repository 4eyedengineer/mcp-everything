#!/bin/bash
# Master setup script for KinD local development environment
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=============================================="
echo "  MCP Everything - Local K8s Setup (KinD)    "
echo "=============================================="
echo ""

# Check prerequisites
echo "==> Checking prerequisites..."

check_command() {
    if ! command -v $1 &> /dev/null; then
        echo "Error: $1 is not installed"
        echo "Install instructions: $2"
        exit 1
    fi
    echo "  ✓ $1 found"
}

check_command docker "https://docs.docker.com/get-docker/"
check_command kind "https://kind.sigs.k8s.io/docs/user/quick-start/#installation"
check_command kubectl "https://kubernetes.io/docs/tasks/tools/"

# Check Docker is running
if ! docker info &> /dev/null; then
    echo "Error: Docker daemon is not running"
    echo "Start Docker and try again"
    exit 1
fi
echo "  ✓ Docker daemon is running"

echo ""
echo "==> Starting setup..."
echo ""

# Step 1: Create registry (before cluster so network exists)
echo "[1/5] Setting up local Docker registry..."
"${SCRIPT_DIR}/install-registry.sh"
echo ""

# Step 2: Create KinD cluster
echo "[2/5] Creating KinD cluster..."
"${SCRIPT_DIR}/create-cluster.sh"
echo ""

# Connect registry to kind network (after cluster creation)
echo "Connecting registry to kind network..."
docker network connect kind kind-registry 2>/dev/null || true

# Configure cluster to use local registry
echo "Configuring cluster to use local registry..."
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: ConfigMap
metadata:
  name: local-registry-hosting
  namespace: kube-public
data:
  localRegistryHosting.v1: |
    host: "localhost:5000"
    help: "https://kind.sigs.k8s.io/docs/user/local-registry/"
EOF
echo ""

# Step 3: Install nginx-ingress
echo "[3/4] Installing nginx-ingress controller..."
"${SCRIPT_DIR}/install-ingress.sh"
echo ""

# Step 4: Configure DNS
#
# ArgoCD used to be installed here, to sync manifests the backend committed to
# a GitOps repo. The backend now creates Deployments/Services/Secrets directly
# via the Kubernetes API (K8sControlPlaneService), so nothing in this local
# flow needs ArgoCD any more.
echo "[4/4] Configuring DNS..."
"${SCRIPT_DIR}/setup-dns.sh"
echo ""

echo "=============================================="
echo "  Setup Complete!                             "
echo "=============================================="
echo ""
echo "Services available:"
echo "  - Kubernetes cluster: kind-mcp-local"
echo "  - Docker registry:    localhost:5000"
echo "  - ArgoCD UI:          http://localhost:30080"
echo "  - Ingress HTTP:       http://localhost:80"
echo "  - Ingress HTTPS:      https://localhost:443"
echo ""
echo "Test endpoints:"
echo "  - http://test.mcp.localhost"
echo "  - http://<server-id>.mcp.localhost"
echo ""
echo "Next steps:"
echo "  0. kubectl apply -k k8s/mcp-servers   # namespace + RBAC + quotas"
echo "  1. Start backend with LOCAL_DEV=true"
echo "  2. Generate an MCP server through the chat interface"
echo "  3. Server will be deployed to: http://<server-id>.mcp.localhost"
echo ""
echo "To run E2E test:"
echo "  ./scripts/kind/test-e2e.sh"
echo ""
echo "To cleanup:"
echo "  ./scripts/kind/cleanup.sh"
