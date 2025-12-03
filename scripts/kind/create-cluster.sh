#!/bin/bash
# Create KinD cluster with port mappings for MCP local development
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLUSTER_NAME="mcp-local"
CONFIG_FILE="${SCRIPT_DIR}/../../k8s/kind/cluster-config.yaml"

echo "==> Creating KinD cluster: ${CLUSTER_NAME}"

# Check if cluster already exists
if kind get clusters 2>/dev/null | grep -q "^${CLUSTER_NAME}$"; then
    echo "Cluster '${CLUSTER_NAME}' already exists"
    echo "Use ./cleanup.sh to remove it first, or continue with existing cluster"
    exit 0
fi

# Create cluster with config
if [ -f "${CONFIG_FILE}" ]; then
    echo "Using config: ${CONFIG_FILE}"
    kind create cluster --config "${CONFIG_FILE}"
else
    echo "Error: Config file not found: ${CONFIG_FILE}"
    exit 1
fi

# Wait for cluster to be ready
echo "==> Waiting for cluster to be ready..."
kubectl wait --for=condition=Ready nodes --all --timeout=120s

echo "==> Cluster '${CLUSTER_NAME}' created successfully!"
kubectl cluster-info --context kind-${CLUSTER_NAME}
