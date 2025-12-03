#!/bin/bash
# End-to-end test for the local KinD deployment pipeline
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${SCRIPT_DIR}/../.."
REGISTRY="localhost:5000"
TEST_SERVER_ID="test-mcp-server"
TEST_IMAGE="${REGISTRY}/${TEST_SERVER_ID}:latest"

echo "=============================================="
echo "  MCP Everything - E2E Pipeline Test          "
echo "=============================================="
echo ""

# Check prerequisites
echo "==> Checking prerequisites..."

# Check KinD cluster is running
if ! kubectl cluster-info --context kind-mcp-local &>/dev/null; then
    echo "Error: KinD cluster 'mcp-local' is not running"
    echo "Run ./scripts/kind/setup.sh first"
    exit 1
fi
echo "  ✓ KinD cluster is running"

# Check registry is running
if ! docker ps --format '{{.Names}}' | grep -q "kind-registry"; then
    echo "Error: Local registry is not running"
    exit 1
fi
echo "  ✓ Local registry is running"

# Check ingress is ready
if ! kubectl get pods -n ingress-nginx -l app.kubernetes.io/component=controller -o jsonpath='{.items[0].status.phase}' 2>/dev/null | grep -q "Running"; then
    echo "Error: Ingress controller is not ready"
    exit 1
fi
echo "  ✓ Ingress controller is running"

echo ""
echo "==> [1/5] Building test MCP server image..."

# Create a simple test server
TEST_DIR=$(mktemp -d)
cat > "${TEST_DIR}/server.js" << 'EOF'
const http = require('http');

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'healthy', server: 'test-mcp-server' }));
  } else if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      name: 'test-mcp-server',
      version: '1.0.0',
      description: 'Test MCP server for E2E validation'
    }));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Test MCP server running on port ${PORT}`);
});
EOF

cat > "${TEST_DIR}/Dockerfile" << 'EOF'
FROM node:20-alpine
WORKDIR /app
COPY server.js .
EXPOSE 3000
CMD ["node", "server.js"]
EOF

# Build and push
docker build -t ${TEST_IMAGE} ${TEST_DIR}
rm -rf ${TEST_DIR}
echo "  ✓ Image built"

echo ""
echo "==> [2/5] Pushing image to local registry..."
docker push ${TEST_IMAGE}
echo "  ✓ Image pushed to ${REGISTRY}"

echo ""
echo "==> [3/5] Creating Kubernetes manifests..."

MANIFESTS_DIR="${PROJECT_ROOT}/k8s/local-gitops/servers/${TEST_SERVER_ID}"
mkdir -p ${MANIFESTS_DIR}

cat > "${MANIFESTS_DIR}/deployment.yaml" << EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${TEST_SERVER_ID}
  namespace: mcp-servers
  labels:
    app: ${TEST_SERVER_ID}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ${TEST_SERVER_ID}
  template:
    metadata:
      labels:
        app: ${TEST_SERVER_ID}
    spec:
      containers:
        - name: mcp-server
          image: ${TEST_IMAGE}
          ports:
            - containerPort: 3000
          livenessProbe:
            httpGet:
              path: /health
              port: 3000
            initialDelaySeconds: 5
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /health
              port: 3000
            initialDelaySeconds: 3
            periodSeconds: 5
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 200m
              memory: 128Mi
EOF

cat > "${MANIFESTS_DIR}/service.yaml" << EOF
apiVersion: v1
kind: Service
metadata:
  name: ${TEST_SERVER_ID}
  namespace: mcp-servers
spec:
  selector:
    app: ${TEST_SERVER_ID}
  ports:
    - port: 80
      targetPort: 3000
  type: ClusterIP
EOF

cat > "${MANIFESTS_DIR}/ingress.yaml" << EOF
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${TEST_SERVER_ID}
  namespace: mcp-servers
  annotations:
    kubernetes.io/ingress.class: nginx
spec:
  rules:
    - host: ${TEST_SERVER_ID}.mcp.localhost
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: ${TEST_SERVER_ID}
                port:
                  number: 80
EOF

echo "  ✓ Manifests created in ${MANIFESTS_DIR}"

echo ""
echo "==> [4/5] Applying manifests to cluster..."

# Ensure namespace exists
kubectl create namespace mcp-servers --dry-run=client -o yaml | kubectl apply -f -

# Apply manifests
kubectl apply -f ${MANIFESTS_DIR}/

echo "  ✓ Manifests applied"

echo ""
echo "==> [5/5] Waiting for deployment and testing endpoint..."

# Wait for deployment
echo "  Waiting for pods to be ready..."
kubectl wait --namespace mcp-servers \
    --for=condition=ready pod \
    --selector=app=${TEST_SERVER_ID} \
    --timeout=120s

echo "  ✓ Pod is ready"

# Try to add host entry if possible (may fail without sudo)
if ! grep -q "${TEST_SERVER_ID}.mcp.localhost" /etc/hosts 2>/dev/null; then
    echo "  Attempting to add ${TEST_SERVER_ID}.mcp.localhost to /etc/hosts..."
    echo "127.0.0.1 ${TEST_SERVER_ID}.mcp.localhost" | sudo tee -a /etc/hosts > /dev/null 2>&1 || {
        echo "  Note: Could not modify /etc/hosts (needs sudo). Using Host header instead."
    }
fi

# Wait a moment for ingress to update
sleep 3

# Test the endpoint using Host header (works without /etc/hosts modification)
echo "  Testing HTTP endpoint..."
HOSTNAME="${TEST_SERVER_ID}.mcp.localhost"
RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" -H "Host: ${HOSTNAME}" "http://127.0.0.1/health" 2>/dev/null || echo "000")

if [ "$RESPONSE" = "200" ]; then
    echo "  ✓ Health check passed (HTTP 200)"

    # Get full response
    echo ""
    echo "Server response:"
    curl -s -H "Host: ${HOSTNAME}" "http://127.0.0.1/health" | jq . 2>/dev/null || curl -s -H "Host: ${HOSTNAME}" "http://127.0.0.1/health"
else
    echo "  ✗ Health check failed (HTTP ${RESPONSE})"
    echo ""
    echo "Debug info:"
    echo "  Pods:"
    kubectl get pods -n mcp-servers
    echo ""
    echo "  Ingress:"
    kubectl get ingress -n mcp-servers
    echo ""
    echo "  Services:"
    kubectl get svc -n mcp-servers
    echo ""
    echo "  Trying direct pod access..."
    POD_NAME=$(kubectl get pods -n mcp-servers -l app=${TEST_SERVER_ID} -o jsonpath='{.items[0].metadata.name}')
    kubectl exec -n mcp-servers ${POD_NAME} -- wget -qO- http://localhost:3000/health 2>/dev/null || echo "  Direct pod access failed"
    exit 1
fi

echo ""
echo "=============================================="
echo "  E2E Test Passed!                            "
echo "=============================================="
echo ""
echo "Test server accessible at:"
echo "  http://${TEST_SERVER_ID}.mcp.localhost"
echo "  http://${TEST_SERVER_ID}.mcp.localhost/health"
echo ""
echo "To clean up test resources:"
echo "  kubectl delete -f ${MANIFESTS_DIR}/"
echo "  rm -rf ${MANIFESTS_DIR}"
echo ""
echo "Pipeline validated:"
echo "  ✓ Build image"
echo "  ✓ Push to local registry"
echo "  ✓ Create K8s manifests"
echo "  ✓ Apply to cluster"
echo "  ✓ Ingress routing"
echo "  ✓ Health check"
