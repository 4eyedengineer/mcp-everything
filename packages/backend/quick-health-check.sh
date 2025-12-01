#!/bin/bash

# MCP Everything Backend - Quick Health Check Script
# Performs rapid health checks on all API endpoints

API_BASE="http://localhost:3000"
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}=== MCP Everything Backend Health Check ===${NC}\n"

# Function to check endpoint
check_endpoint() {
    local method=$1
    local endpoint=$2
    local data=$3
    local expected_code=$4
    local description=$5

    if [ "$method" = "GET" ]; then
        response=$(curl -s -o /dev/null -w "%{http_code}" "$API_BASE$endpoint")
    else
        response=$(curl -s -o /dev/null -w "%{http_code}" -X "$method" \
            -H "Content-Type: application/json" \
            -d "$data" \
            "$API_BASE$endpoint")
    fi

    if [ "$response" = "$expected_code" ]; then
        echo -e "${GREEN}✓${NC} $description ($endpoint) - HTTP $response"
        return 0
    else
        echo -e "${RED}✗${NC} $description ($endpoint) - Expected $expected_code, got $response"
        return 1
    fi
}

# Check if server is running
if ! curl -s -o /dev/null "$API_BASE/health"; then
    echo -e "${RED}ERROR: Server is not running at $API_BASE${NC}"
    echo "Please start the server with: npm start"
    exit 1
fi

# Track results
total=0
passed=0

# Run health checks
echo -e "${YELLOW}Basic Endpoints:${NC}"
check_endpoint "GET" "/" "" "200" "Root endpoint" && ((passed++))
((total++))

check_endpoint "GET" "/health" "" "200" "Health check" && ((passed++))
((total++))

echo -e "\n${YELLOW}POST Endpoints:${NC}"
check_endpoint "POST" "/chat" '{"message":"test"}' "201" "Chat endpoint" && ((passed++))
((total++))

check_endpoint "POST" "/generate" '{"githubUrl":"https://github.com/sindresorhus/is"}' "201" "Generate endpoint" && ((passed++))
((total++))

echo -e "\n${YELLOW}Error Handling:${NC}"
check_endpoint "GET" "/nonexistent" "" "404" "404 handling" && ((passed++))
((total++))

check_endpoint "POST" "/chat" '{}' "400" "Validation error" && ((passed++))
((total++))

# Performance check
echo -e "\n${YELLOW}Performance Check:${NC}"
start_time=$(date +%s%3N)
curl -s -o /dev/null "$API_BASE/health"
end_time=$(date +%s%3N)
response_time=$((end_time - start_time))

if [ "$response_time" -lt 100 ]; then
    echo -e "${GREEN}✓${NC} Health endpoint response time: ${response_time}ms"
    ((passed++))
else
    echo -e "${YELLOW}⚠${NC} Health endpoint response time: ${response_time}ms (slow)"
fi
((total++))

# Summary
echo -e "\n${YELLOW}=== Health Check Summary ===${NC}"
echo "Total checks: $total"
echo -e "Passed: ${GREEN}$passed${NC}"
failed=$((total - passed))
echo -e "Failed: ${RED}$failed${NC}"

# Calculate success rate
success_rate=$((passed * 100 / total))
if [ "$success_rate" -eq 100 ]; then
    echo -e "Status: ${GREEN}HEALTHY (100%)${NC}"
    exit 0
elif [ "$success_rate" -ge 80 ]; then
    echo -e "Status: ${YELLOW}DEGRADED ($success_rate%)${NC}"
    exit 1
else
    echo -e "Status: ${RED}UNHEALTHY ($success_rate%)${NC}"
    exit 2
fi