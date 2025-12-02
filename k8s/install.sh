#!/bin/bash
set -euo pipefail

# Master installation script for MCP K8s infrastructure
#
# Usage:
#   ./install.sh --domain yourdomain.com --email admin@yourdomain.com
#
# This script installs:
# 1. nginx-ingress controller
# 2. cert-manager
# 3. ClusterIssuer for Let's Encrypt
# 4. Wildcard certificate for *.mcp.domain
#
# Prerequisites:
# - Kubernetes cluster access (kubectl configured)
# - Helm 3.x installed
# - Cloudflare API token (for DNS-01 challenge)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Default values
DOMAIN=""
EMAIL=""
CLOUDFLARE_TOKEN=""
SKIP_INGRESS=false
SKIP_CERTMANAGER=false
DRY_RUN=false

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

usage() {
    cat << EOF
Usage: $0 [OPTIONS]

Options:
    --domain DOMAIN          Your base domain (required)
    --email EMAIL            Email for Let's Encrypt notifications (required)
    --cloudflare-token TOKEN Cloudflare API token (or set interactively)
    --skip-ingress           Skip nginx-ingress installation
    --skip-certmanager       Skip cert-manager installation
    --dry-run                Show what would be done without making changes
    -h, --help               Show this help message

Example:
    $0 --domain example.com --email admin@example.com
EOF
    exit 1
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --domain)
            DOMAIN="$2"
            shift 2
            ;;
        --email)
            EMAIL="$2"
            shift 2
            ;;
        --cloudflare-token)
            CLOUDFLARE_TOKEN="$2"
            shift 2
            ;;
        --skip-ingress)
            SKIP_INGRESS=true
            shift
            ;;
        --skip-certmanager)
            SKIP_CERTMANAGER=true
            shift
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        -h|--help)
            usage
            ;;
        *)
            echo "Unknown option: $1"
            usage
            ;;
    esac
done

# Validate required arguments
if [[ -z "$DOMAIN" ]]; then
    echo -e "${RED}Error: --domain is required${NC}"
    usage
fi

if [[ -z "$EMAIL" ]]; then
    echo -e "${RED}Error: --email is required${NC}"
    usage
fi

echo "=== MCP Infrastructure Installation ==="
echo "Domain: $DOMAIN"
echo "Email: $EMAIL"
echo ""

# Check prerequisites
echo "Checking prerequisites..."

if ! command -v kubectl &> /dev/null; then
    echo -e "${RED}Error: kubectl is not installed${NC}"
    exit 1
fi
echo -e "${GREEN}✓${NC} kubectl found"

if ! command -v helm &> /dev/null; then
    echo -e "${RED}Error: helm is not installed${NC}"
    exit 1
fi
echo -e "${GREEN}✓${NC} helm found"

# Check cluster connectivity
if ! kubectl cluster-info &> /dev/null; then
    echo -e "${RED}Error: Cannot connect to Kubernetes cluster${NC}"
    exit 1
fi
echo -e "${GREEN}✓${NC} Kubernetes cluster accessible"

# Check mcp-servers namespace exists
if ! kubectl get namespace mcp-servers &> /dev/null; then
    echo -e "${RED}Error: mcp-servers namespace does not exist${NC}"
    echo "Run: kubectl apply -f mcp-server-deployments/base/"
    exit 1
fi
echo -e "${GREEN}✓${NC} mcp-servers namespace exists"

echo ""

if [[ "$DRY_RUN" == "true" ]]; then
    echo -e "${YELLOW}DRY RUN MODE - No changes will be made${NC}"
    echo ""
fi

# Step 1: Install nginx-ingress
if [[ "$SKIP_INGRESS" != "true" ]]; then
    echo "=== Step 1: Installing nginx-ingress ==="
    if [[ "$DRY_RUN" != "true" ]]; then
        "$SCRIPT_DIR/02-ingress-nginx/install.sh"
    else
        echo "Would run: $SCRIPT_DIR/02-ingress-nginx/install.sh"
    fi
    echo ""
else
    echo "=== Step 1: Skipping nginx-ingress (--skip-ingress) ==="
    echo ""
fi

# Step 2: Install cert-manager
if [[ "$SKIP_CERTMANAGER" != "true" ]]; then
    echo "=== Step 2: Installing cert-manager ==="
    if [[ "$DRY_RUN" != "true" ]]; then
        "$SCRIPT_DIR/03-cert-manager/install.sh"
    else
        echo "Would run: $SCRIPT_DIR/03-cert-manager/install.sh"
    fi
    echo ""
else
    echo "=== Step 2: Skipping cert-manager (--skip-certmanager) ==="
    echo ""
fi

# Step 3: Create Cloudflare secret
echo "=== Step 3: Creating Cloudflare API token secret ==="
if [[ -z "$CLOUDFLARE_TOKEN" ]]; then
    echo "Enter your Cloudflare API token (or Ctrl+C to skip):"
    read -rs CLOUDFLARE_TOKEN
    echo ""
fi

if [[ -n "$CLOUDFLARE_TOKEN" ]]; then
    if [[ "$DRY_RUN" != "true" ]]; then
        kubectl create secret generic cloudflare-api-token \
            --namespace cert-manager \
            --from-literal=api-token="$CLOUDFLARE_TOKEN" \
            --dry-run=client -o yaml | kubectl apply -f -
        echo -e "${GREEN}✓${NC} Cloudflare secret created"
    else
        echo "Would create: cloudflare-api-token secret in cert-manager namespace"
    fi
else
    echo -e "${YELLOW}Warning: No Cloudflare token provided. Create manually:${NC}"
    echo "  cp 04-certificates/cloudflare-secret.yaml.example 04-certificates/cloudflare-secret.yaml"
    echo "  # Edit with your token"
    echo "  kubectl apply -f 04-certificates/cloudflare-secret.yaml"
fi
echo ""

# Step 4: Apply ClusterIssuer
echo "=== Step 4: Applying ClusterIssuer ==="
if [[ "$DRY_RUN" != "true" ]]; then
    # Replace email in cluster-issuer.yaml
    sed "s/admin@yourdomain.com/$EMAIL/g" "$SCRIPT_DIR/04-certificates/cluster-issuer.yaml" | kubectl apply -f -
    echo -e "${GREEN}✓${NC} ClusterIssuer applied"
else
    echo "Would apply: cluster-issuer.yaml with email=$EMAIL"
fi
echo ""

# Step 5: Apply Wildcard Certificate
echo "=== Step 5: Applying Wildcard Certificate ==="
if [[ "$DRY_RUN" != "true" ]]; then
    # Replace domain in wildcard-certificate.yaml
    sed "s/yourdomain.com/$DOMAIN/g" "$SCRIPT_DIR/04-certificates/wildcard-certificate.yaml" | kubectl apply -f -
    echo -e "${GREEN}✓${NC} Wildcard Certificate applied"
else
    echo "Would apply: wildcard-certificate.yaml with domain=$DOMAIN"
fi
echo ""

# Step 6: Apply test ingress
echo "=== Step 6: Applying Test Ingress ==="
if [[ "$DRY_RUN" != "true" ]]; then
    # Replace domain in test-ingress.yaml
    sed "s/yourdomain.com/$DOMAIN/g" "$SCRIPT_DIR/05-test/test-ingress.yaml" | kubectl apply -f -
    echo -e "${GREEN}✓${NC} Test Ingress applied"
else
    echo "Would apply: test-ingress.yaml with domain=$DOMAIN"
fi
echo ""

# Done
echo "=== Installation Complete ==="
echo ""
echo "Next steps:"
echo "1. Configure DNS: *.mcp.$DOMAIN -> Ingress LoadBalancer IP"
echo "   Get IP with: kubectl get svc -n ingress-nginx ingress-nginx-controller"
echo ""
echo "2. Wait for certificate to be issued (may take a few minutes)"
echo "   Check with: kubectl get certificate -n mcp-servers"
echo ""
echo "3. Test HTTPS connectivity:"
echo "   curl -v https://test.mcp.$DOMAIN"
echo ""
echo "4. Run verification:"
echo "   $SCRIPT_DIR/05-test/verify.sh $DOMAIN"
