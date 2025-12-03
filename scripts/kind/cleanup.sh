#!/bin/bash
# Cleanup KinD cluster and related resources
set -e

CLUSTER_NAME="mcp-local"
REGISTRY_NAME="kind-registry"

echo "=============================================="
echo "  MCP Everything - Local K8s Cleanup          "
echo "=============================================="
echo ""

# Delete KinD cluster
if kind get clusters 2>/dev/null | grep -q "^${CLUSTER_NAME}$"; then
    echo "==> Deleting KinD cluster: ${CLUSTER_NAME}..."
    kind delete cluster --name ${CLUSTER_NAME}
    echo "  ✓ Cluster deleted"
else
    echo "  - Cluster '${CLUSTER_NAME}' does not exist"
fi

# Remove local registry
if docker ps -a --format '{{.Names}}' | grep -q "^${REGISTRY_NAME}$"; then
    echo "==> Removing local registry: ${REGISTRY_NAME}..."
    docker rm -f ${REGISTRY_NAME}
    echo "  ✓ Registry removed"
else
    echo "  - Registry '${REGISTRY_NAME}' does not exist"
fi

# Clean up /etc/hosts entries (optional, requires sudo)
HOSTS_FILE="/etc/hosts"
if grep -q "mcp.localhost" ${HOSTS_FILE} 2>/dev/null; then
    echo ""
    echo "==> /etc/hosts contains mcp.localhost entries"
    read -p "Remove them? (requires sudo) [y/N]: " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        sudo sed -i.bak '/mcp.localhost/d' ${HOSTS_FILE}
        echo "  ✓ Hosts entries removed"
    else
        echo "  - Skipped (entries remain in /etc/hosts)"
    fi
fi

# Clean up local-gitops/servers directory
SERVERS_DIR="$(dirname "${BASH_SOURCE[0]}")/../../k8s/local-gitops/servers"
if [ -d "${SERVERS_DIR}" ]; then
    # Remove everything except .gitkeep
    find "${SERVERS_DIR}" -mindepth 1 ! -name '.gitkeep' -exec rm -rf {} + 2>/dev/null || true
    echo "  ✓ Cleared local-gitops/servers/"
fi

echo ""
echo "=============================================="
echo "  Cleanup Complete!                           "
echo "=============================================="
echo ""
echo "To set up again:"
echo "  ./scripts/kind/setup.sh"
