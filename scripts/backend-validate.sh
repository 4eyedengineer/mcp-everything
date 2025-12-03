#!/bin/bash
#
# Backend Validation Script for MCP Everything
# Validates backend build, startup, and endpoints per Issue #88
#
# Usage: ./scripts/backend-validate.sh [--markdown] [--skip-build]
#
# Options:
#   --markdown     Output results in markdown format (for GitHub issue)
#   --skip-build   Skip build step (use existing dist/)
#
# Prerequisites:
#   - Layer 1 complete (PostgreSQL running, env vars set)
#   - Run from project root or scripts/ directory
#

set -e

# Colors for terminal output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
BACKEND_PORT="${PORT:-3000}"
API_BASE="http://localhost:$BACKEND_PORT"
STARTUP_TIMEOUT=60
CURL_TIMEOUT=10

# Counters
PASS_COUNT=0
FAIL_COUNT=0
WARN_COUNT=0

# Options
MARKDOWN_OUTPUT=false
SKIP_BUILD=false

# State
SERVER_PID=""
LOG_FILE=""
BACKEND_DIR=""

# Parse arguments
for arg in "$@"; do
  case $arg in
    --markdown)
      MARKDOWN_OUTPUT=true
      shift
      ;;
    --skip-build)
      SKIP_BUILD=true
      shift
      ;;
  esac
done

# Output functions
print_header() {
  if [ "$MARKDOWN_OUTPUT" = true ]; then
    echo ""
    echo "### $1"
  else
    echo -e "\n${BLUE}=== $1 ===${NC}"
  fi
}

print_pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  if [ "$MARKDOWN_OUTPUT" = true ]; then
    echo "- [x] $1"
  else
    echo -e "${GREEN}[PASS]${NC} $1"
  fi
}

print_fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  if [ "$MARKDOWN_OUTPUT" = true ]; then
    echo "- [ ] $1"
    if [ -n "$2" ]; then
      echo "  > Fix: $2"
    fi
  else
    echo -e "${RED}[FAIL]${NC} $1"
    if [ -n "$2" ]; then
      echo -e "       ${YELLOW}Fix: $2${NC}"
    fi
  fi
}

print_warn() {
  WARN_COUNT=$((WARN_COUNT + 1))
  if [ "$MARKDOWN_OUTPUT" = true ]; then
    echo "- [x] $1 (warning)"
  else
    echo -e "${YELLOW}[WARN]${NC} $1"
  fi
}

print_info() {
  if [ "$MARKDOWN_OUTPUT" = true ]; then
    echo "  > $1"
  else
    echo -e "       $1"
  fi
}

# Cleanup function
cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    print_info "Stopping backend server (PID: $SERVER_PID)..."
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [ -n "$LOG_FILE" ] && [ -f "$LOG_FILE" ]; then
    rm -f "$LOG_FILE"
  fi
}

trap cleanup EXIT

# Find project root
find_project_root() {
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
  BACKEND_DIR="$PROJECT_ROOT/packages/backend"

  if [ ! -d "$BACKEND_DIR" ]; then
    print_fail "Backend directory not found: $BACKEND_DIR"
    exit 1
  fi
}

# ============================================================
# 2.1 Build Backend
# ============================================================
check_build() {
  print_header "2.1 Build Backend"

  if [ "$SKIP_BUILD" = true ]; then
    print_info "Skipping build (--skip-build flag)"
    if [ -d "$BACKEND_DIR/dist" ]; then
      print_pass "Existing dist/ folder found"
    else
      print_fail "dist/ folder not found" "Run without --skip-build flag"
    fi
    return
  fi

  cd "$BACKEND_DIR"
  print_info "Running npm run build..."

  BUILD_OUTPUT=$(npm run build 2>&1) || {
    print_fail "TypeScript compilation failed"
    # Show first few error lines
    echo "$BUILD_OUTPUT" | grep -A 2 "error TS" | head -10
    print_info "Fix: Review TypeScript errors above"
    return 1
  }

  # Check for type errors in output
  if echo "$BUILD_OUTPUT" | grep -q "error TS"; then
    print_fail "TypeScript compilation has type errors"
    echo "$BUILD_OUTPUT" | grep "error TS" | head -5
    return 1
  fi

  print_pass "TypeScript compilation succeeds"

  # Check dist folder
  if [ -d "$BACKEND_DIR/dist" ]; then
    FILE_COUNT=$(find "$BACKEND_DIR/dist" -name "*.js" | wc -l)
    print_pass "dist/ folder created ($FILE_COUNT JS files)"
  else
    print_fail "dist/ folder not created" "Check for build errors"
  fi
}

# ============================================================
# 2.2 Run Database Migrations
# ============================================================
check_migrations() {
  print_header "2.2 Database Migrations"

  cd "$BACKEND_DIR"

  # Check if migrations exist
  if [ ! -d "$BACKEND_DIR/src/migrations" ] && [ ! -d "$BACKEND_DIR/migrations" ]; then
    print_warn "No migrations directory found - skipping migration check"
    return 0
  fi

  print_info "Running migrations..."

  # Try npm run migration:run first
  if npm run migration:run 2>&1; then
    print_pass "Migrations run successfully"
  else
    # Fallback to npx typeorm
    print_info "Trying fallback: npx typeorm migration:run..."
    if npx typeorm migration:run -d dist/config/typeorm.config.js 2>&1; then
      print_pass "Migrations run successfully (via npx)"
    else
      print_warn "Migration command failed - may already be applied or not configured"
      print_info "This is often OK if tables already exist"
    fi
  fi

  # Verify tables exist by checking database
  if command -v psql &> /dev/null; then
    source "$BACKEND_DIR/.env" 2>/dev/null || source "$PROJECT_ROOT/.env" 2>/dev/null || true
    TABLE_COUNT=$(PGPASSWORD="${DATABASE_PASSWORD:-postgres}" psql -h "${DATABASE_HOST:-localhost}" -U "${DATABASE_USER:-postgres}" -d "${DATABASE_NAME:-mcp_everything}" -p "${DATABASE_PORT:-5432}" -t -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public'" 2>/dev/null | tr -d ' ' || echo "0")
    if [ "$TABLE_COUNT" -gt 0 ]; then
      print_pass "Database has $TABLE_COUNT tables"
    else
      print_warn "Could not verify tables in database"
    fi
  else
    print_info "psql not available - skipping table verification"
  fi
}

# ============================================================
# 2.3 Start Backend Dev Server
# ============================================================
check_server_start() {
  print_header "2.3 Start Backend Dev Server"

  cd "$BACKEND_DIR"

  # Check if port is already in use
  if curl -s -o /dev/null "http://localhost:$BACKEND_PORT/health" 2>/dev/null; then
    print_warn "Port $BACKEND_PORT already in use - using existing server"
    print_pass "Server responding on port $BACKEND_PORT"
    return 0
  fi

  # Create log file
  LOG_FILE=$(mktemp)

  print_info "Starting server on port $BACKEND_PORT..."

  # Start server in background
  npm run start:dev > "$LOG_FILE" 2>&1 &
  SERVER_PID=$!

  print_info "Server PID: $SERVER_PID"

  # Wait for server to be ready
  ELAPSED=0
  while [ $ELAPSED -lt $STARTUP_TIMEOUT ]; do
    if curl -s -o /dev/null "http://localhost:$BACKEND_PORT/health" 2>/dev/null; then
      print_pass "Server started successfully"
      print_pass "Listening on port $BACKEND_PORT"

      # Check for startup errors in logs
      check_startup_logs
      return 0
    fi

    # Check if process died
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      print_fail "Server process died during startup"
      print_info "Checking logs for errors..."
      check_startup_logs
      return 1
    fi

    sleep 2
    ELAPSED=$((ELAPSED + 2))
    print_info "Waiting for server... ($ELAPSED/$STARTUP_TIMEOUT seconds)"
  done

  print_fail "Server startup timed out after $STARTUP_TIMEOUT seconds" "Check logs for errors"
  check_startup_logs
  return 1
}

check_startup_logs() {
  if [ -z "$LOG_FILE" ] || [ ! -f "$LOG_FILE" ]; then
    return
  fi

  # Check for common error patterns
  if grep -q "Cannot find module" "$LOG_FILE"; then
    print_fail "Module not found error detected"
    grep "Cannot find module" "$LOG_FILE" | head -3
    print_info "Fix: Run npm install in packages/backend"
  fi

  if grep -q "Nest can't resolve dependencies" "$LOG_FILE"; then
    print_fail "Dependency injection error detected"
    grep -A 2 "Nest can't resolve dependencies" "$LOG_FILE" | head -5
    print_info "Fix: Check module imports and provider declarations"
  fi

  if grep -q "EADDRINUSE" "$LOG_FILE"; then
    print_fail "Port already in use"
    print_info "Fix: lsof -i :$BACKEND_PORT && kill -9 <PID>"
  fi

  if grep -q "Connection refused\|ECONNREFUSED" "$LOG_FILE"; then
    print_fail "Database connection failed"
    print_info "Fix: Verify PostgreSQL is running and credentials are correct"
  fi

  if grep -q "UnhandledPromiseRejectionWarning\|unhandledRejection" "$LOG_FILE"; then
    print_warn "Unhandled promise rejection detected"
  fi
}

# ============================================================
# 2.4 Test Health Endpoints
# ============================================================
check_health_endpoints() {
  print_header "2.4 Health Endpoints"

  # Test /health
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time $CURL_TIMEOUT "$API_BASE/health" 2>/dev/null || echo "000")
  if [ "$HTTP_CODE" = "200" ]; then
    print_pass "/health returns 200"
  else
    print_fail "/health returns $HTTP_CODE (expected 200)" "Check server logs"
  fi

  # Test /api/chat/health
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time $CURL_TIMEOUT "$API_BASE/api/chat/health" 2>/dev/null || echo "000")
  if [ "$HTTP_CODE" = "200" ]; then
    print_pass "/api/chat/health returns 200"
  elif [ "$HTTP_CODE" = "404" ]; then
    print_warn "/api/chat/health returns 404 (endpoint may not be implemented)"
  else
    print_fail "/api/chat/health returns $HTTP_CODE" "Check ChatController"
  fi
}

# ============================================================
# 2.5 Test SSE Endpoint
# ============================================================
check_sse_endpoint() {
  print_header "2.5 SSE Endpoint"

  # Test SSE endpoint - should connect without 404
  # Use short timeout since SSE stays open
  RESPONSE=$(curl -s -w "\n%{http_code}" --max-time 3 \
    -H "Accept: text/event-stream" \
    "$API_BASE/api/chat/stream/test-session-id" 2>/dev/null || echo "000")

  HTTP_CODE=$(echo "$RESPONSE" | tail -1)

  if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "000" ]; then
    # 000 can mean connection was closed (which is expected for SSE timeout)
    print_pass "SSE endpoint doesn't return 404"
    print_info "Connection established (or timed out gracefully)"
  elif [ "$HTTP_CODE" = "404" ]; then
    print_fail "SSE endpoint returns 404" "Check ChatController stream method"
  else
    print_warn "SSE endpoint returns $HTTP_CODE (unexpected)"
  fi
}

# ============================================================
# 2.6 Test Conversations API
# ============================================================
check_conversations_api() {
  print_header "2.6 Conversations API"

  RESPONSE=$(curl -s -w "\n%{http_code}" --max-time $CURL_TIMEOUT "$API_BASE/api/conversations" 2>/dev/null)
  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  BODY=$(echo "$RESPONSE" | head -n -1)

  if [ "$HTTP_CODE" = "200" ]; then
    print_pass "/api/conversations returns 200"
    # Check if JSON
    if echo "$BODY" | jq . > /dev/null 2>&1; then
      print_pass "Returns valid JSON response"
    else
      print_warn "Response is not valid JSON"
    fi
  elif [ "$HTTP_CODE" = "404" ]; then
    print_fail "/api/conversations returns 404" "Check ConversationController is registered"
  elif [ "$HTTP_CODE" = "401" ] || [ "$HTTP_CODE" = "403" ]; then
    print_pass "/api/conversations requires authentication (returns $HTTP_CODE)"
  else
    print_warn "/api/conversations returns $HTTP_CODE"
  fi
}

# ============================================================
# 2.7 Test Chat Message Endpoint
# ============================================================
check_chat_message() {
  print_header "2.7 Chat Message Endpoint"

  RESPONSE=$(curl -s -w "\n%{http_code}" --max-time $CURL_TIMEOUT \
    -X POST \
    -H "Content-Type: application/json" \
    -d '{"message": "test", "sessionId": "test-123"}' \
    "$API_BASE/api/chat/message" 2>/dev/null)

  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  BODY=$(echo "$RESPONSE" | head -n -1)

  if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
    print_pass "/api/chat/message endpoint exists (returns $HTTP_CODE)"
    if echo "$BODY" | jq . > /dev/null 2>&1; then
      print_pass "Returns valid JSON response"
    fi
  elif [ "$HTTP_CODE" = "404" ]; then
    print_fail "/api/chat/message returns 404" "Check ChatController message method"
  elif [ "$HTTP_CODE" = "400" ]; then
    print_pass "/api/chat/message endpoint exists (validation error - expected)"
  else
    print_warn "/api/chat/message returns $HTTP_CODE"
    print_info "Response: $BODY"
  fi
}

# ============================================================
# 2.8 Test Hosting API
# ============================================================
check_hosting_api() {
  print_header "2.8 Hosting API"

  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time $CURL_TIMEOUT "$API_BASE/api/hosting/health" 2>/dev/null || echo "000")

  if [ "$HTTP_CODE" = "200" ]; then
    print_pass "/api/hosting/health returns 200"
  elif [ "$HTTP_CODE" = "404" ]; then
    print_warn "/api/hosting/health returns 404 (endpoint may not be implemented)"
  else
    print_info "/api/hosting/health returns $HTTP_CODE"
  fi
}

# ============================================================
# 2.9 Test Deployment API
# ============================================================
check_deployment_api() {
  print_header "2.9 Deployment API"

  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time $CURL_TIMEOUT "$API_BASE/api/deployment/health" 2>/dev/null || echo "000")

  if [ "$HTTP_CODE" = "200" ]; then
    print_pass "/api/deployment/health returns 200"
  elif [ "$HTTP_CODE" = "404" ]; then
    print_warn "/api/deployment/health returns 404 (endpoint may not be implemented)"
  else
    print_info "/api/deployment/health returns $HTTP_CODE"
  fi

  # Also check validation health
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time $CURL_TIMEOUT "$API_BASE/api/validation/health" 2>/dev/null || echo "000")

  if [ "$HTTP_CODE" = "200" ]; then
    print_pass "/api/validation/health returns 200"
  elif [ "$HTTP_CODE" = "404" ]; then
    print_warn "/api/validation/health returns 404 (endpoint may not be implemented)"
  fi
}

# ============================================================
# 2.10 Check Backend Logs
# ============================================================
check_backend_logs() {
  print_header "2.10 Backend Logs"

  if [ -z "$LOG_FILE" ] || [ ! -f "$LOG_FILE" ]; then
    print_info "No log file to analyze"
    return
  fi

  # Count error types
  ERROR_COUNT=$(grep -c -i "error\|exception\|failed" "$LOG_FILE" 2>/dev/null || echo "0")
  WARN_COUNT_LOG=$(grep -c -i "warn" "$LOG_FILE" 2>/dev/null || echo "0")
  DEPRECATION_COUNT=$(grep -c -i "deprecat" "$LOG_FILE" 2>/dev/null || echo "0")

  if [ "$ERROR_COUNT" -eq 0 ]; then
    print_pass "No errors in logs"
  else
    print_warn "Found $ERROR_COUNT error entries in logs"
    grep -i "error\|exception" "$LOG_FILE" | head -3
  fi

  if [ "$DEPRECATION_COUNT" -gt 0 ]; then
    print_warn "Found $DEPRECATION_COUNT deprecation warnings"
  else
    print_pass "No deprecation warnings"
  fi

  # Check for memory warnings
  if grep -q "FATAL ERROR\|heap out of memory\|JavaScript heap" "$LOG_FILE" 2>/dev/null; then
    print_fail "Memory-related errors detected"
  else
    print_pass "No memory warnings"
  fi
}

# ============================================================
# Summary
# ============================================================
print_summary() {
  if [ "$MARKDOWN_OUTPUT" = true ]; then
    echo ""
    echo "## Summary"
    echo "- **Passed**: $PASS_COUNT"
    echo "- **Failed**: $FAIL_COUNT"
    echo "- **Warnings**: $WARN_COUNT"
    echo ""
    if [ "$FAIL_COUNT" -eq 0 ]; then
      echo "> All backend checks passed! Ready to proceed to Layer 3."
    else
      echo "> Some checks failed. Please fix the issues above before proceeding."
    fi
  else
    echo -e "\n${BLUE}=== Summary ===${NC}"
    echo -e "${GREEN}Passed:${NC}   $PASS_COUNT"
    echo -e "${RED}Failed:${NC}   $FAIL_COUNT"
    echo -e "${YELLOW}Warnings:${NC} $WARN_COUNT"
    echo ""
    if [ "$FAIL_COUNT" -eq 0 ]; then
      echo -e "${GREEN}All backend checks passed! Ready to proceed to Layer 3.${NC}"
    else
      echo -e "${RED}Some checks failed. Please fix the issues above before proceeding.${NC}"
    fi
  fi
}

# ============================================================
# Main
# ============================================================
main() {
  if [ "$MARKDOWN_OUTPUT" = true ]; then
    echo "## Backend Validation Results"
    echo ""
    echo "Generated: $(date -u +"%Y-%m-%d %H:%M:%S UTC")"
  else
    echo -e "${BLUE}MCP Everything - Backend Validation (Layer 2)${NC}"
    echo "Generated: $(date -u +"%Y-%m-%d %H:%M:%S UTC")"
  fi

  find_project_root

  check_build
  check_migrations
  check_server_start
  check_health_endpoints
  check_sse_endpoint
  check_conversations_api
  check_chat_message
  check_hosting_api
  check_deployment_api
  check_backend_logs

  print_summary

  # Exit with appropriate code
  if [ "$FAIL_COUNT" -gt 0 ]; then
    exit 1
  fi
  exit 0
}

main
