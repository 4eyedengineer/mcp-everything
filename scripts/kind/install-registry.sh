#!/bin/bash
# Install local Docker registry at localhost:5000 for KinD
set -e

REGISTRY_NAME="kind-registry"
REGISTRY_PORT="5000"
CLUSTER_NAME="mcp-local"

echo "==> Setting up local Docker registry at localhost:${REGISTRY_PORT}"

# Check if registry already exists
if docker ps -a --format '{{.Names}}' | grep -q "^${REGISTRY_NAME}$"; then
    if docker ps --format '{{.Names}}' | grep -q "^${REGISTRY_NAME}$"; then
        echo "Registry '${REGISTRY_NAME}' is already running"
    else
        echo "Starting existing registry container..."
        docker start ${REGISTRY_NAME}
    fi
else
    echo "Creating new registry container..."
    docker run -d \
        --restart=always \
        --name "${REGISTRY_NAME}" \
        -p "127.0.0.1:${REGISTRY_PORT}:5000" \
        registry:2
fi

# Connect registry to KinD network if not already connected
NETWORK_NAME="kind"
if docker network inspect ${NETWORK_NAME} >/dev/null 2>&1; then
    if ! docker network inspect ${NETWORK_NAME} | grep -q "${REGISTRY_NAME}"; then
        echo "Connecting registry to KinD network..."
        docker network connect ${NETWORK_NAME} ${REGISTRY_NAME} 2>/dev/null || true
    fi
fi

# Create ConfigMap for registry endpoint (for kubelet to use)
echo "==> Configuring cluster to use local registry..."
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: ConfigMap
metadata:
  name: local-registry-hosting
  namespace: kube-public
data:
  localRegistryHosting.v1: |
    host: "localhost:${REGISTRY_PORT}"
    help: "https://kind.sigs.k8s.io/docs/user/local-registry/"
EOF

echo "==> Local registry configured at localhost:${REGISTRY_PORT}"
echo ""
echo "To push images:"
echo "  docker tag myimage localhost:${REGISTRY_PORT}/myimage"
echo "  docker push localhost:${REGISTRY_PORT}/myimage"
