#!/bin/bash
# Configure DNS resolution for *.mcp.localhost
set -e

DOMAIN="mcp.localhost"
HOSTS_FILE="/etc/hosts"
HOSTS_ENTRY="127.0.0.1 ${DOMAIN}"

echo "==> Configuring DNS for *.${DOMAIN}"

# Check if running on macOS or Linux
if [[ "$OSTYPE" == "darwin"* ]]; then
    echo "Detected macOS"

    # On macOS, .localhost domains typically resolve to 127.0.0.1 automatically
    # But we'll add explicit entries for reliability

    # Check if entry already exists
    if grep -q "${DOMAIN}" ${HOSTS_FILE} 2>/dev/null; then
        echo "DNS entry for ${DOMAIN} already exists in ${HOSTS_FILE}"
    else
        echo "Adding ${DOMAIN} to ${HOSTS_FILE} (requires sudo)..."
        echo "${HOSTS_ENTRY}" | sudo tee -a ${HOSTS_FILE} > /dev/null

        # Flush DNS cache on macOS
        sudo dscacheutil -flushcache
        sudo killall -HUP mDNSResponder 2>/dev/null || true
    fi

else
    echo "Detected Linux"

    # On Linux, check if systemd-resolved handles .localhost
    if systemctl is-active --quiet systemd-resolved 2>/dev/null; then
        echo "systemd-resolved is active"
        echo ".localhost domains should resolve automatically to 127.0.0.1"
    fi

    # Add explicit entry to /etc/hosts for reliability
    if grep -q "${DOMAIN}" ${HOSTS_FILE} 2>/dev/null; then
        echo "DNS entry for ${DOMAIN} already exists in ${HOSTS_FILE}"
    else
        echo "Adding ${DOMAIN} to ${HOSTS_FILE} (requires sudo)..."
        echo "${HOSTS_ENTRY}" | sudo tee -a ${HOSTS_FILE} > /dev/null
    fi
fi

# Add common test subdomains
TEST_DOMAINS="test.mcp.localhost api.mcp.localhost"
for subdomain in ${TEST_DOMAINS}; do
    if ! grep -q "${subdomain}" ${HOSTS_FILE} 2>/dev/null; then
        echo "127.0.0.1 ${subdomain}" | sudo tee -a ${HOSTS_FILE} > /dev/null
    fi
done

echo ""
echo "==> DNS configured for *.${DOMAIN}"
echo ""
echo "Test with:"
echo "  ping ${DOMAIN}"
echo "  ping test.${DOMAIN}"
echo ""
echo "Note: Wildcard DNS (*.mcp.localhost) is handled by nginx-ingress."
echo "      Individual subdomains are added to /etc/hosts for direct testing."
