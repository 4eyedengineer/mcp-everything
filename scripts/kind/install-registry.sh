#!/bin/bash
# Install local Docker registry at localhost:5000 for KinD
set -e

REGISTRY_NAME="kind-registry"
REGISTRY_PORT="5000"

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

echo "==> Local registry container ready at localhost:${REGISTRY_PORT}"
echo ""
echo "To push images:"
echo "  docker tag myimage localhost:${REGISTRY_PORT}/myimage"
echo "  docker push localhost:${REGISTRY_PORT}/myimage"
