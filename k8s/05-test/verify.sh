#!/bin/bash
set -euo pipefail

# Verification script for K8s ingress and SSL infrastructure
#
# Usage: ./verify.sh [domain]
# Example: ./verify.sh yourdomain.com

DOMAIN="${1:-yourdomain.com}"
TEST_HOST="test.mcp.$DOMAIN"

echo "=== MCP Infrastructure Verification ==="
echo "Domain: $DOMAIN"
echo "Test host: $TEST_HOST"
echo ""

# Track overall status
ERRORS=0

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

check_pass() {
    echo -e "${GREEN}[PASS]${NC} $1"
}

check_fail() {
    echo -e "${RED}[FAIL]${NC} $1"
    ((ERRORS++))
}

check_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

# 1. Check nginx-ingress
echo "=== Checking nginx-ingress ==="
if kubectl get namespace ingress-nginx &> /dev/null; then
    check_pass "ingress-nginx namespace exists"
else
    check_fail "ingress-nginx namespace not found"
fi

INGRESS_PODS=$(kubectl get pods -n ingress-nginx -l app.kubernetes.io/name=ingress-nginx -o jsonpath='{.items[*].status.phase}' 2>/dev/null || echo "")
if [[ "$INGRESS_PODS" == *"Running"* ]]; then
    check_pass "nginx-ingress pods are running"
else
    check_fail "nginx-ingress pods not running"
fi

LB_IP=$(kubectl get svc -n ingress-nginx ingress-nginx-controller -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || echo "")
LB_HOSTNAME=$(kubectl get svc -n ingress-nginx ingress-nginx-controller -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || echo "")
if [[ -n "$LB_IP" ]]; then
    check_pass "LoadBalancer IP: $LB_IP"
elif [[ -n "$LB_HOSTNAME" ]]; then
    check_pass "LoadBalancer Hostname: $LB_HOSTNAME"
else
    check_fail "No LoadBalancer IP/Hostname assigned"
fi

echo ""

# 2. Check cert-manager
echo "=== Checking cert-manager ==="
if kubectl get namespace cert-manager &> /dev/null; then
    check_pass "cert-manager namespace exists"
else
    check_fail "cert-manager namespace not found"
fi

CERTMANAGER_PODS=$(kubectl get pods -n cert-manager -l app=cert-manager -o jsonpath='{.items[*].status.phase}' 2>/dev/null || echo "")
if [[ "$CERTMANAGER_PODS" == *"Running"* ]]; then
    check_pass "cert-manager pods are running"
else
    check_fail "cert-manager pods not running"
fi

echo ""

# 3. Check ClusterIssuer
echo "=== Checking ClusterIssuer ==="
ISSUER_READY=$(kubectl get clusterissuer letsencrypt-prod -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || echo "")
if [[ "$ISSUER_READY" == "True" ]]; then
    check_pass "letsencrypt-prod ClusterIssuer is ready"
else
    check_fail "letsencrypt-prod ClusterIssuer not ready"
    echo "  Check: kubectl describe clusterissuer letsencrypt-prod"
fi

echo ""

# 4. Check Certificate
echo "=== Checking Certificate ==="
CERT_READY=$(kubectl get certificate mcp-wildcard-cert -n mcp-servers -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || echo "")
if [[ "$CERT_READY" == "True" ]]; then
    check_pass "mcp-wildcard-cert is ready"
else
    check_fail "mcp-wildcard-cert not ready"
    echo "  Check: kubectl describe certificate mcp-wildcard-cert -n mcp-servers"
fi

# Check TLS secret exists
if kubectl get secret mcp-wildcard-tls -n mcp-servers &> /dev/null; then
    check_pass "mcp-wildcard-tls secret exists"
else
    check_fail "mcp-wildcard-tls secret not found"
fi

echo ""

# 5. Test HTTPS connectivity (if domain resolves)
echo "=== Testing HTTPS Connectivity ==="
if command -v curl &> /dev/null; then
    echo "Testing: https://$TEST_HOST"

    # First check if domain resolves
    if host "$TEST_HOST" &> /dev/null; then
        # Test HTTPS connection
        HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 10 "https://$TEST_HOST" 2>/dev/null || echo "000")

        if [[ "$HTTP_CODE" == "503" ]] || [[ "$HTTP_CODE" == "404" ]]; then
            check_pass "HTTPS works (HTTP $HTTP_CODE - no backend, as expected)"
        elif [[ "$HTTP_CODE" == "000" ]]; then
            check_fail "Could not connect to https://$TEST_HOST"
        else
            check_pass "HTTPS works (HTTP $HTTP_CODE)"
        fi

        # Check certificate
        CERT_INFO=$(echo | openssl s_client -servername "$TEST_HOST" -connect "$TEST_HOST:443" 2>/dev/null | openssl x509 -noout -subject 2>/dev/null || echo "")
        if [[ -n "$CERT_INFO" ]]; then
            check_pass "SSL Certificate valid: $CERT_INFO"
        else
            check_warn "Could not verify SSL certificate"
        fi
    else
        check_warn "DNS not configured: $TEST_HOST does not resolve"
        echo "  Configure DNS: *.mcp.$DOMAIN -> $LB_IP"
    fi
else
    check_warn "curl not installed, skipping connectivity test"
fi

echo ""
echo "=== Summary ==="
if [[ $ERRORS -eq 0 ]]; then
    echo -e "${GREEN}All checks passed!${NC}"
    exit 0
else
    echo -e "${RED}$ERRORS check(s) failed${NC}"
    exit 1
fi
