#!/bin/bash
#
# End-to-End MCP Server Generation Test Script
# Per Issue #156: First real end-to-end test of the generation pipeline
#
# Usage: ./scripts/e2e-test.sh [--skip-build] [--skip-cleanup] [--markdown]
#
# Options:
#   --skip-build    Skip TypeScript compilation test
#   --skip-cleanup  Don't cleanup generated files after test
#   --markdown      Output results in markdown format (for GitHub issue)
#   --verbose       Show detailed curl output
#
# Prerequisites:
#   - Backend running on port 3000
#   - PostgreSQL database running and migrated
#   - Environment variables configured (.env)
#

set -e

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Colors for terminal output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Configuration
BACKEND_PORT="${BACKEND_PORT:-3000}"
BACKEND_URL="http://localhost:${BACKEND_PORT}"
TEST_TIMEOUT="${TEST_TIMEOUT:-180}"  # 3 minutes default for generation
SSE_TIMEOUT="${SSE_TIMEOUT:-120}"    # 2 minutes for SSE streaming
OUTPUT_DIR="${PROJECT_ROOT}/test-outputs"
GENERATED_SERVERS_DIR="${PROJECT_ROOT}/generated-servers"

# Test Counters
TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0
TESTS_SKIPPED=0

# Options
SKIP_BUILD=false
SKIP_CLEANUP=false
MARKDOWN_OUTPUT=false
VERBOSE=false

# Test results storage
declare -A TEST_RESULTS
declare -A TEST_DURATIONS
declare -A TEST_ERRORS

# Parse arguments
for arg in "$@"; do
  case $arg in
    --skip-build)
      SKIP_BUILD=true
      shift
      ;;
    --skip-cleanup)
      SKIP_CLEANUP=true
      shift
      ;;
    --markdown)
      MARKDOWN_OUTPUT=true
      shift
      ;;
    --verbose)
      VERBOSE=true
      shift
      ;;
    --help)
      echo "Usage: $0 [--skip-build] [--skip-cleanup] [--markdown] [--verbose]"
      exit 0
      ;;
  esac
done

# Logging functions
log_pass() {
  if [ "$MARKDOWN_OUTPUT" = true ]; then
    echo "- [x] $1"
  else
    echo -e "${GREEN}[PASS]${NC} $1"
  fi
  ((TESTS_PASSED++))
}

log_fail() {
  if [ "$MARKDOWN_OUTPUT" = true ]; then
    echo "- [ ] $1"
  else
    echo -e "${RED}[FAIL]${NC} $1"
  fi
  ((TESTS_FAILED++))
}

log_warn() {
  if [ "$MARKDOWN_OUTPUT" = true ]; then
    echo "- [~] $1 (warning)"
  else
    echo -e "${YELLOW}[WARN]${NC} $1"
  fi
}

log_info() {
  if [ "$MARKDOWN_OUTPUT" = true ]; then
    echo "  - $1"
  else
    echo -e "${BLUE}[INFO]${NC} $1"
  fi
}

log_skip() {
  if [ "$MARKDOWN_OUTPUT" = true ]; then
    echo "- [~] $1 (skipped)"
  else
    echo -e "${YELLOW}[SKIP]${NC} $1"
  fi
  ((TESTS_SKIPPED++))
}

log_section() {
  if [ "$MARKDOWN_OUTPUT" = true ]; then
    echo ""
    echo "### $1"
    echo ""
  else
    echo ""
    echo -e "${CYAN}=== $1 ===${NC}"
    echo ""
  fi
}

log_debug() {
  if [ "$VERBOSE" = true ]; then
    echo -e "${BLUE}[DEBUG]${NC} $1"
  fi
}

# Print header
print_header() {
  if [ "$MARKDOWN_OUTPUT" = true ]; then
    echo "## End-to-End MCP Server Generation Test Results"
    echo ""
    echo "**Generated**: $(date)"
    echo "**Backend URL**: $BACKEND_URL"
    echo ""
  else
    echo ""
    echo "=============================================="
    echo "  MCP Everything - E2E Generation Test"
    echo "=============================================="
    echo "  Generated: $(date)"
    echo "  Backend: $BACKEND_URL"
    echo ""
  fi
}

# Print summary
print_summary() {
  if [ "$MARKDOWN_OUTPUT" = true ]; then
    echo ""
    echo "---"
    echo "### Summary"
    echo ""
    echo "| Metric | Count |"
    echo "|--------|-------|"
    echo "| Passed | $TESTS_PASSED |"
    echo "| Failed | $TESTS_FAILED |"
    echo "| Skipped | $TESTS_SKIPPED |"
    echo "| Total | $((TESTS_PASSED + TESTS_FAILED + TESTS_SKIPPED)) |"
    echo ""
    if [ $TESTS_FAILED -gt 0 ]; then
      echo "**Status**: :x: Tests Failed"
    else
      echo "**Status**: :white_check_mark: All Tests Passed"
    fi
  else
    echo ""
    echo "=============================================="
    echo -e "  ${GREEN}PASSED:${NC}  $TESTS_PASSED"
    echo -e "  ${RED}FAILED:${NC}  $TESTS_FAILED"
    echo -e "  ${YELLOW}SKIPPED:${NC} $TESTS_SKIPPED"
    echo "  --------------"
    echo "  TOTAL:   $((TESTS_PASSED + TESTS_FAILED + TESTS_SKIPPED))"
    echo "=============================================="
    if [ $TESTS_FAILED -gt 0 ]; then
      echo -e "  ${RED}STATUS: TESTS FAILED${NC}"
    else
      echo -e "  ${GREEN}STATUS: ALL TESTS PASSED${NC}"
    fi
    echo "=============================================="
  fi
}

# Check if port is listening
check_port() {
  local port=$1
  nc -z localhost "$port" 2>/dev/null
}

# Generate a unique session ID
generate_session_id() {
  echo "e2e-test-$(date +%s)-$RANDOM"
}

# Initialize test output directory
init_output_dir() {
  mkdir -p "$OUTPUT_DIR"

  # Create timestamped subdirectory for this run
  local run_dir="$OUTPUT_DIR/run-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$run_dir"

  echo "$run_dir"
}

# Check prerequisites
check_prerequisites() {
  log_section "Prerequisites Check"

  local all_ok=true

  # Check backend is running
  if check_port "$BACKEND_PORT"; then
    log_pass "Backend running on port $BACKEND_PORT"
  else
    log_fail "Backend NOT running on port $BACKEND_PORT"
    log_info "Start with: cd packages/backend && npm run start:dev"
    all_ok=false
  fi

  # Check backend health
  local health_response
  health_response=$(curl -s --max-time 5 "${BACKEND_URL}/api/health" 2>/dev/null) || health_response=""

  if echo "$health_response" | grep -q "ok"; then
    log_pass "Backend health check passed"
  else
    log_fail "Backend health check failed"
    log_info "Response: $health_response"
    all_ok=false
  fi

  # Check chat service health
  local chat_health
  chat_health=$(curl -s --max-time 5 "${BACKEND_URL}/api/chat/health" 2>/dev/null) || chat_health=""

  if echo "$chat_health" | grep -q "ok"; then
    log_pass "Chat service healthy"
  else
    log_fail "Chat service health check failed"
    log_info "Response: $chat_health"
    all_ok=false
  fi

  # Check environment variables
  if [ -f "${PROJECT_ROOT}/.env" ] || [ -f "${PROJECT_ROOT}/packages/backend/.env" ]; then
    log_pass "Environment file exists"
  else
    log_warn "No .env file found - using defaults"
  fi

  # Check if node and npm are available
  if command -v node &> /dev/null && command -v npm &> /dev/null; then
    log_pass "Node.js and npm available"
    log_info "Node version: $(node --version)"
  else
    log_fail "Node.js or npm not found"
    all_ok=false
  fi

  # Check if tsc is available (for build validation)
  if [ "$SKIP_BUILD" = false ]; then
    if command -v npx &> /dev/null; then
      log_pass "npx available for TypeScript compilation"
    else
      log_warn "npx not available - build tests will be skipped"
      SKIP_BUILD=true
    fi
  fi

  if [ "$all_ok" = false ]; then
    return 1
  fi

  return 0
}

# Send a chat message and capture the response
# Returns: conversation_id from the response
send_chat_message() {
  local session_id=$1
  local message=$2
  local conversation_id=${3:-""}

  local payload
  if [ -n "$conversation_id" ]; then
    payload="{\"message\":\"$message\",\"sessionId\":\"$session_id\",\"conversationId\":\"$conversation_id\"}"
  else
    payload="{\"message\":\"$message\",\"sessionId\":\"$session_id\"}"
  fi

  log_debug "Sending message: $message"
  log_debug "Payload: $payload"

  local response
  response=$(curl -s -X POST \
    -H "Content-Type: application/json" \
    -d "$payload" \
    --max-time 30 \
    "${BACKEND_URL}/api/chat/message" 2>&1)

  log_debug "Response: $response"

  # Extract conversation ID from response
  local conv_id
  conv_id=$(echo "$response" | grep -o '"conversationId":"[^"]*"' | cut -d'"' -f4)

  if [ -n "$conv_id" ]; then
    echo "$conv_id"
    return 0
  else
    echo ""
    return 1
  fi
}

# Stream SSE events and capture results
# This function reads SSE events until completion or timeout
stream_sse_events() {
  local session_id=$1
  local output_file=$2
  local timeout=${3:-$SSE_TIMEOUT}

  log_debug "Starting SSE stream for session: $session_id"

  # Use timeout and curl to read SSE stream
  # Write events to output file
  timeout "$timeout" curl -s -N \
    -H "Accept: text/event-stream" \
    "${BACKEND_URL}/api/chat/stream/${session_id}" > "$output_file" 2>&1 &

  local curl_pid=$!

  # Wait for completion or check for specific events
  local elapsed=0
  local check_interval=5

  while [ $elapsed -lt $timeout ]; do
    sleep $check_interval
    elapsed=$((elapsed + check_interval))

    # Check if process is still running
    if ! kill -0 $curl_pid 2>/dev/null; then
      log_debug "SSE stream ended"
      break
    fi

    # Check for completion event in output file
    if grep -q '"isComplete":true' "$output_file" 2>/dev/null; then
      log_debug "Found completion event after ${elapsed}s"
      kill $curl_pid 2>/dev/null || true
      break
    fi

    # Check for error event
    if grep -q '"type":"error"' "$output_file" 2>/dev/null; then
      log_debug "Found error event after ${elapsed}s"
      break
    fi

    log_debug "Waiting... ${elapsed}s / ${timeout}s"
  done

  # Cleanup
  kill $curl_pid 2>/dev/null || true
  wait $curl_pid 2>/dev/null || true

  return 0
}

# Test 1: GitHub URL Flow
test_github_url_flow() {
  log_section "Test 1: GitHub URL Flow"

  local test_name="github_url_flow"
  local start_time=$(date +%s)
  local session_id=$(generate_session_id)
  local output_dir="$RUN_DIR/test1-github-url"

  mkdir -p "$output_dir"

  log_info "Test: Generate MCP server from GitHub URL"
  log_info "Input: https://github.com/anthropics/anthropic-sdk-typescript"
  log_info "Session ID: $session_id"

  # Send the generation request
  local message="Generate an MCP server for https://github.com/anthropics/anthropic-sdk-typescript"
  local conversation_id
  conversation_id=$(send_chat_message "$session_id" "$message")

  if [ -z "$conversation_id" ]; then
    log_fail "Failed to start generation - no conversation ID returned"
    TEST_ERRORS[$test_name]="No conversation ID returned from chat message"
    return 1
  fi

  log_info "Conversation ID: $conversation_id"

  # Stream SSE events
  local sse_output="$output_dir/sse-events.txt"
  stream_sse_events "$session_id" "$sse_output" "$TEST_TIMEOUT"

  # Save conversation ID for later use
  echo "$conversation_id" > "$output_dir/conversation-id.txt"

  # Analyze results
  local end_time=$(date +%s)
  local duration=$((end_time - start_time))
  TEST_DURATIONS[$test_name]=$duration

  log_info "Duration: ${duration}s"

  # Check for success indicators
  local success=true

  # Check if generation completed
  if grep -q '"isComplete":true' "$sse_output" 2>/dev/null; then
    log_pass "Generation completed (isComplete=true found)"
  else
    log_fail "Generation did not complete - no isComplete=true event"
    success=false
  fi

  # Check if generated code was produced
  if grep -q '"generatedCode"' "$sse_output" 2>/dev/null; then
    log_pass "Generated code present in response"
  else
    log_fail "No generated code in response"
    success=false
  fi

  # Check for errors
  if grep -q '"type":"error"' "$sse_output" 2>/dev/null; then
    local error_msg
    error_msg=$(grep '"type":"error"' "$sse_output" | head -1)
    log_fail "Error event detected"
    log_info "Error: $error_msg"
    TEST_ERRORS[$test_name]="$error_msg"
    success=false
  fi

  # Check if files were written to disk
  local generated_path="${GENERATED_SERVERS_DIR}/${conversation_id}"
  if [ -d "$generated_path" ]; then
    log_pass "Generated files written to: $generated_path"

    # Check for expected files
    if [ -f "$generated_path/src/index.ts" ]; then
      log_pass "Main file exists: src/index.ts"
    else
      log_warn "Main file not found: src/index.ts"
    fi

    if [ -f "$generated_path/package.json" ]; then
      log_pass "package.json exists"
    else
      log_warn "package.json not found"
    fi

    # Copy generated files to output dir
    cp -r "$generated_path" "$output_dir/generated-server" 2>/dev/null || true

    # Validate TypeScript compilation
    if [ "$SKIP_BUILD" = false ] && [ -f "$generated_path/package.json" ]; then
      validate_typescript_build "$generated_path" "$output_dir"
    fi

  else
    log_fail "Generated files directory not found: $generated_path"
    success=false
  fi

  if [ "$success" = true ]; then
    TEST_RESULTS[$test_name]="PASS"
    return 0
  else
    TEST_RESULTS[$test_name]="FAIL"
    return 1
  fi
}

# Test 2: Service Name Flow
test_service_name_flow() {
  log_section "Test 2: Service Name Flow"

  local test_name="service_name_flow"
  local start_time=$(date +%s)
  local session_id=$(generate_session_id)
  local output_dir="$RUN_DIR/test2-service-name"

  mkdir -p "$output_dir"

  log_info "Test: Generate MCP server from service name"
  log_info "Input: GitHub API"
  log_info "Session ID: $session_id"

  # Send the generation request
  local message="Generate an MCP server for the GitHub API"
  local conversation_id
  conversation_id=$(send_chat_message "$session_id" "$message")

  if [ -z "$conversation_id" ]; then
    log_fail "Failed to start generation - no conversation ID returned"
    TEST_ERRORS[$test_name]="No conversation ID returned"
    return 1
  fi

  log_info "Conversation ID: $conversation_id"

  # Stream SSE events
  local sse_output="$output_dir/sse-events.txt"
  stream_sse_events "$session_id" "$sse_output" "$TEST_TIMEOUT"

  echo "$conversation_id" > "$output_dir/conversation-id.txt"

  local end_time=$(date +%s)
  local duration=$((end_time - start_time))
  TEST_DURATIONS[$test_name]=$duration

  log_info "Duration: ${duration}s"

  # Analyze results
  local success=true

  # For service name flow, we might get clarification questions
  if grep -q '"needsUserInput":true' "$sse_output" 2>/dev/null; then
    log_pass "Clarification flow triggered (expected for ambiguous input)"
    log_info "This is expected behavior - system asks for clarification"
  elif grep -q '"isComplete":true' "$sse_output" 2>/dev/null; then
    log_pass "Generation completed"
  else
    log_warn "Neither completion nor clarification detected"
  fi

  # Check for research activity
  if grep -q '"currentNode":"researchCoordinator"' "$sse_output" 2>/dev/null || \
     grep -q 'research' "$sse_output" 2>/dev/null; then
    log_pass "Research node was executed"
  else
    log_warn "No evidence of research node execution"
  fi

  # Check for errors
  if grep -q '"type":"error"' "$sse_output" 2>/dev/null; then
    local error_msg
    error_msg=$(grep '"type":"error"' "$sse_output" | head -1)
    log_fail "Error event detected"
    log_info "Error: $error_msg"
    TEST_ERRORS[$test_name]="$error_msg"
    success=false
  fi

  if [ "$success" = true ]; then
    TEST_RESULTS[$test_name]="PASS"
    return 0
  else
    TEST_RESULTS[$test_name]="FAIL"
    return 1
  fi
}

# Test 3: Error Recovery
test_error_recovery() {
  log_section "Test 3: Error Recovery"

  local test_name="error_recovery"
  local start_time=$(date +%s)
  local session_id=$(generate_session_id)
  local output_dir="$RUN_DIR/test3-error-recovery"

  mkdir -p "$output_dir"

  log_info "Test: Error handling for nonexistent repository"
  log_info "Input: https://github.com/nonexistent-user-12345/nonexistent-repo-67890"
  log_info "Session ID: $session_id"

  # Send request for nonexistent repo
  local message="Generate an MCP server for https://github.com/nonexistent-user-12345/nonexistent-repo-67890"
  local conversation_id
  conversation_id=$(send_chat_message "$session_id" "$message")

  if [ -z "$conversation_id" ]; then
    log_fail "Failed to send message - no conversation ID returned"
    TEST_ERRORS[$test_name]="No conversation ID returned"
    return 1
  fi

  log_info "Conversation ID: $conversation_id"

  # Stream SSE events (shorter timeout for error case)
  local sse_output="$output_dir/sse-events.txt"
  stream_sse_events "$session_id" "$sse_output" 60

  echo "$conversation_id" > "$output_dir/conversation-id.txt"

  local end_time=$(date +%s)
  local duration=$((end_time - start_time))
  TEST_DURATIONS[$test_name]=$duration

  log_info "Duration: ${duration}s"

  # Analyze results - we EXPECT graceful error handling
  local success=true

  # Check for graceful error handling (not a stack trace)
  if grep -q '"type":"error"' "$sse_output" 2>/dev/null; then
    local error_content
    error_content=$(grep '"type":"error"' "$sse_output" | head -1)

    # Check it's a user-friendly message, not a stack trace
    if echo "$error_content" | grep -q "at .*\.ts:" 2>/dev/null; then
      log_fail "Stack trace exposed to user (security issue)"
      success=false
    else
      log_pass "Error returned in user-friendly format"
    fi
  else
    log_warn "No explicit error event - checking for graceful handling"
  fi

  # Check that no sensitive information is exposed
  if grep -qi "password\|secret\|token\|api_key" "$sse_output" 2>/dev/null; then
    log_fail "Sensitive information potentially exposed in error"
    success=false
  else
    log_pass "No sensitive information in response"
  fi

  # The system should NOT crash
  local health_after
  health_after=$(curl -s --max-time 5 "${BACKEND_URL}/api/chat/health" 2>/dev/null) || health_after=""

  if echo "$health_after" | grep -q "ok"; then
    log_pass "Backend still healthy after error"
  else
    log_fail "Backend health degraded after error"
    success=false
  fi

  if [ "$success" = true ]; then
    TEST_RESULTS[$test_name]="PASS"
    return 0
  else
    TEST_RESULTS[$test_name]="FAIL"
    return 1
  fi
}

# Validate TypeScript build
validate_typescript_build() {
  local generated_path=$1
  local output_dir=$2

  log_info "Validating TypeScript compilation..."

  # Check if package.json exists
  if [ ! -f "$generated_path/package.json" ]; then
    log_skip "No package.json - skipping build validation"
    return 1
  fi

  # Create a temp directory for build test
  local build_dir="$output_dir/build-test"
  mkdir -p "$build_dir"

  # Copy files
  cp -r "$generated_path"/* "$build_dir/" 2>/dev/null || true

  # Install dependencies (with timeout)
  log_info "Installing dependencies..."
  local npm_output="$output_dir/npm-install.log"

  if timeout 60 npm install --prefix "$build_dir" > "$npm_output" 2>&1; then
    log_pass "npm install succeeded"
  else
    log_fail "npm install failed"
    log_info "See: $npm_output"
    return 1
  fi

  # Run TypeScript compilation
  log_info "Running TypeScript compilation..."
  local tsc_output="$output_dir/tsc-build.log"

  if timeout 30 npx --prefix "$build_dir" tsc --noEmit > "$tsc_output" 2>&1; then
    log_pass "TypeScript compilation succeeded (no errors)"
  else
    local error_count
    error_count=$(grep -c "error TS" "$tsc_output" 2>/dev/null || echo "0")
    log_fail "TypeScript compilation failed ($error_count errors)"
    log_info "See: $tsc_output"

    # Show first few errors
    if [ "$VERBOSE" = true ]; then
      head -20 "$tsc_output"
    fi

    return 1
  fi

  return 0
}

# Cleanup function
cleanup() {
  if [ "$SKIP_CLEANUP" = true ]; then
    log_info "Skipping cleanup (--skip-cleanup flag set)"
    return
  fi

  log_info "Cleanup completed"
}

# Generate bug report template for failed tests
generate_bug_report() {
  local output_file="$RUN_DIR/bug-report.md"

  if [ $TESTS_FAILED -eq 0 ]; then
    return
  fi

  cat > "$output_file" << 'EOF'
# E2E Test Failure Report

## Test Run Summary
EOF

  echo "- **Date**: $(date)" >> "$output_file"
  echo "- **Failed Tests**: $TESTS_FAILED" >> "$output_file"
  echo "" >> "$output_file"

  echo "## Failed Tests" >> "$output_file"
  echo "" >> "$output_file"

  for test_name in "${!TEST_RESULTS[@]}"; do
    if [ "${TEST_RESULTS[$test_name]}" = "FAIL" ]; then
      echo "### $test_name" >> "$output_file"
      echo "" >> "$output_file"
      echo "- **Duration**: ${TEST_DURATIONS[$test_name]:-N/A}s" >> "$output_file"
      echo "- **Error**: ${TEST_ERRORS[$test_name]:-No error details}" >> "$output_file"
      echo "" >> "$output_file"
    fi
  done

  echo "## Next Steps" >> "$output_file"
  echo "" >> "$output_file"
  echo "1. Review SSE event logs in test output directories" >> "$output_file"
  echo "2. Check backend logs for detailed error information" >> "$output_file"
  echo "3. Create GitHub issues for each distinct failure" >> "$output_file"

  log_info "Bug report generated: $output_file"
}

# Main execution
main() {
  print_header

  # Initialize output directory
  RUN_DIR=$(init_output_dir)
  log_info "Test output directory: $RUN_DIR"

  # Check prerequisites
  if ! check_prerequisites; then
    log_section "Cannot Continue"
    log_info "Prerequisites not met. Please fix issues above and retry."
    print_summary
    exit 1
  fi

  # Run tests
  test_github_url_flow || true
  test_service_name_flow || true
  test_error_recovery || true

  # Generate reports
  generate_bug_report

  # Cleanup
  cleanup

  # Print summary
  print_summary

  # Save summary to file
  {
    print_header
    print_summary
  } > "$RUN_DIR/summary.txt"

  log_info ""
  log_info "Full results saved to: $RUN_DIR"

  # Exit with appropriate code
  if [ $TESTS_FAILED -gt 0 ]; then
    exit 1
  fi

  exit 0
}

# Handle interrupts
trap cleanup EXIT

main "$@"
