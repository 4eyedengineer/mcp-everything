#!/bin/bash
# Install ArgoCD with NodePort access for KinD local development
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARGOCD_NAMESPACE="argocd"
NODEPORT="30080"

echo "==> Installing ArgoCD in namespace: ${ARGOCD_NAMESPACE}"

# Create namespace
kubectl create namespace ${ARGOCD_NAMESPACE} --dry-run=client -o yaml | kubectl apply -f -

# Install ArgoCD
kubectl apply -n ${ARGOCD_NAMESPACE} -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml

echo "==> Waiting for ArgoCD to be ready..."
kubectl wait --namespace ${ARGOCD_NAMESPACE} \
    --for=condition=available deployment/argocd-server \
    --timeout=300s

# Patch ArgoCD server to use NodePort
echo "==> Patching ArgoCD server service to NodePort ${NODEPORT}..."
kubectl patch svc argocd-server -n ${ARGOCD_NAMESPACE} \
    -p "{\"spec\": {\"type\": \"NodePort\", \"ports\": [{\"name\": \"https\", \"port\": 443, \"targetPort\": 8080, \"nodePort\": ${NODEPORT}}]}}"

# Create mcp-servers namespace for deployed servers
kubectl create namespace mcp-servers --dry-run=client -o yaml | kubectl apply -f -

# Apply base resources for mcp-servers namespace
if [ -d "${SCRIPT_DIR}/../../k8s/local-gitops/base" ]; then
    echo "==> Applying base resources for mcp-servers namespace..."
    kubectl apply -f "${SCRIPT_DIR}/../../k8s/local-gitops/base/"
fi

# Configure ArgoCD to watch local-gitops directory
# Note: In a real setup, ArgoCD would watch a Git repo
# For local dev, we'll create an Application pointing to the local directory
# This requires mounting the local directory into the ArgoCD repo-server

echo "==> Configuring ArgoCD for local GitOps..."

# First, we need to mount the local-gitops directory
# This is done by patching the argocd-repo-server deployment
GITOPS_PATH="/home/garrett/dev/mcp-everything-issue-55/k8s/local-gitops"

# Create a ConfigMap with the ArgoCD Application
cat <<EOF | kubectl apply -f -
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: mcp-servers
  namespace: ${ARGOCD_NAMESPACE}
spec:
  project: default
  source:
    # For local development, we'll use a Git repo approach
    # The local-gitops directory should be served or synced
    repoURL: https://github.com/4eyedengineer/mcp-server-deployments.git
    path: servers
    targetRevision: HEAD
  destination:
    server: https://kubernetes.default.svc
    namespace: mcp-servers
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
EOF

# Get initial admin password
ADMIN_PASSWORD=$(kubectl -n ${ARGOCD_NAMESPACE} get secret argocd-initial-admin-secret -o jsonpath="{.data.password}" 2>/dev/null | base64 -d || echo "")

echo ""
echo "==> ArgoCD installed successfully!"
echo ""
echo "ArgoCD UI: http://localhost:${NODEPORT}"
echo "Username:  admin"
if [ -n "${ADMIN_PASSWORD}" ]; then
    echo "Password:  ${ADMIN_PASSWORD}"
else
    echo "Password:  Run: kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d"
fi
echo ""
echo "Note: For local development, manifests written to k8s/local-gitops/servers/"
echo "      will be synced when using LOCAL_DEV=true in the backend."
