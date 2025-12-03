#!/bin/bash
#
# Frontend Standalone Validation Script for MCP Everything
# Validates the Angular frontend builds, serves, and renders correctly
# Per Issue #89 (Layer 3: Frontend Standalone Validation)
#
# Usage: ./scripts/frontend-validate.sh [--markdown] [--skip-browser]
#
# Options:
#   --markdown      Output results in markdown format (for GitHub issue)
#   --skip-browser  Skip Playwright browser tests (build validation only)
#

set -e

# Colors for terminal output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
FRONTEND_PORT=4200
BUILD_TIMEOUT=180
DEV_SERVER_TIMEOUT=60

# Counters
PASS_COUNT=0
FAIL_COUNT=0
WARN_COUNT=0

# Options
MARKDOWN_OUTPUT=false
SKIP_BROWSER=false

# Parse arguments
for arg in "$@"; do
  case $arg in
    --markdown)
      MARKDOWN_OUTPUT=true
      shift
      ;;
    --skip-browser)
      SKIP_BROWSER=true
      shift
      ;;
  esac
done

# Get script directory and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

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
  if [ -n "$DEV_SERVER_PID" ] && kill -0 "$DEV_SERVER_PID" 2>/dev/null; then
    print_info "Stopping dev server (PID: $DEV_SERVER_PID)..."
    kill "$DEV_SERVER_PID" 2>/dev/null || true
    wait "$DEV_SERVER_PID" 2>/dev/null || true
  fi

  # Also cleanup any orphaned ng serve processes
  pkill -f "ng serve" 2>/dev/null || true
}

trap cleanup EXIT

# ============================================================
# 3.1 Build Frontend
# ============================================================
check_build() {
  print_header "3.1 Build Frontend"

  cd "$FRONTEND_ROOT"

  # Clean previous build
  rm -rf dist/

  # Run build and capture output
  print_info "Running npm run build..."
  BUILD_START=$(date +%s)

  if BUILD_OUTPUT=$(npm run build 2>&1); then
    BUILD_END=$(date +%s)
    BUILD_TIME=$((BUILD_END - BUILD_START))

    print_pass "Angular compilation succeeds"

    # Check for template errors (Angular emits these as errors)
    if echo "$BUILD_OUTPUT" | grep -qi "template.*error\|NG[0-9]\+:"; then
      print_fail "Template errors found in build output"
    else
      print_pass "No template errors"
    fi

    # Check for TypeScript errors
    if echo "$BUILD_OUTPUT" | grep -qi "TS[0-9]\+:.*error"; then
      print_fail "TypeScript errors found in build output"
    else
      print_pass "No TypeScript errors"
    fi

    # Check dist folder
    if [ -d "dist/" ]; then
      DIST_SIZE=$(du -sh dist/ | cut -f1)
      print_pass "dist/ folder created ($DIST_SIZE)"
    else
      print_fail "dist/ folder not created" "Check build output for errors"
    fi

    # Check build time
    if [ "$BUILD_TIME" -lt 120 ]; then
      print_pass "Build completes in reasonable time (${BUILD_TIME}s)"
    else
      print_warn "Build took ${BUILD_TIME}s (> 2 minutes)"
    fi
  else
    print_fail "Angular compilation failed" "Check npm run build output for errors"
    print_info "Build output (last 20 lines):"
    echo "$BUILD_OUTPUT" | tail -20
    return 1
  fi
}

# ============================================================
# 3.2 Start Dev Server
# ============================================================
check_dev_server() {
  print_header "3.2 Start Dev Server"

  cd "$FRONTEND_ROOT"

  # Kill any existing dev server
  pkill -f "ng serve" 2>/dev/null || true
  sleep 1

  # Start dev server in background
  print_info "Starting dev server..."
  npm run start > /tmp/ng-serve.log 2>&1 &
  DEV_SERVER_PID=$!

  # Wait for server to be ready
  SERVER_READY=false
  for i in $(seq 1 $DEV_SERVER_TIMEOUT); do
    if curl -s http://localhost:$FRONTEND_PORT > /dev/null 2>&1; then
      SERVER_READY=true
      break
    fi
    sleep 1
  done

  if [ "$SERVER_READY" = true ]; then
    print_pass "Dev server starts"
    print_pass "Listening on port $FRONTEND_PORT"

    # Check for build errors in log
    if grep -qi "error\|ERROR" /tmp/ng-serve.log 2>/dev/null; then
      if grep -qi "warning" /tmp/ng-serve.log 2>/dev/null; then
        print_warn "Some warnings in dev server console"
      fi
      # Only fail if there are actual errors (not just the word in a path)
      if grep -E "^\s*ERROR|error TS|error NG" /tmp/ng-serve.log 2>/dev/null; then
        print_fail "Build errors in console" "Check ng serve output"
      else
        print_pass "No build errors in console"
      fi
    else
      print_pass "No build errors in console"
    fi
  else
    print_fail "Dev server did not start within ${DEV_SERVER_TIMEOUT}s"
    print_info "Log output:"
    cat /tmp/ng-serve.log | tail -20
    return 1
  fi
}

# ============================================================
# 3.3 Access in Browser (Basic HTTP check)
# ============================================================
check_browser_access() {
  print_header "3.3 Access in Browser"

  # Check if page loads
  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:$FRONTEND_PORT)

  if [ "$HTTP_STATUS" = "200" ]; then
    print_pass "Page loads (HTTP 200)"
  else
    print_fail "Page did not load (HTTP $HTTP_STATUS)"
    return 1
  fi

  # Check if content is not blank
  PAGE_SIZE=$(curl -s http://localhost:$FRONTEND_PORT | wc -c)
  if [ "$PAGE_SIZE" -gt 1000 ]; then
    print_pass "Page has content (${PAGE_SIZE} bytes)"
  else
    print_fail "Page appears blank or minimal (${PAGE_SIZE} bytes)"
  fi

  # Check for app-root in HTML
  if curl -s http://localhost:$FRONTEND_PORT | grep -q "<app-root"; then
    print_pass "Angular app-root element present"
  else
    print_fail "Angular app-root element missing" "Check index.html has <app-root></app-root>"
  fi
}

# ============================================================
# 3.5 Network/Asset Check (main.js, styles)
# ============================================================
check_assets() {
  print_header "3.5 Network/Asset Check"

  # Get the main page to find asset URLs
  MAIN_HTML=$(curl -s http://localhost:$FRONTEND_PORT)

  # Check main.js (could be main.js or main.*.js)
  MAIN_JS_URL=$(echo "$MAIN_HTML" | grep -oP 'src="[^"]*main[^"]*\.js"' | head -1 | cut -d'"' -f2)
  if [ -n "$MAIN_JS_URL" ]; then
    if curl -s -o /dev/null -w "%{http_code}" "http://localhost:$FRONTEND_PORT$MAIN_JS_URL" | grep -q "200"; then
      print_pass "main.js loads successfully"
    else
      print_fail "main.js failed to load (404)"
    fi
  else
    # Try default path
    if curl -s -o /dev/null -w "%{http_code}" "http://localhost:$FRONTEND_PORT/main.js" | grep -q "200"; then
      print_pass "main.js loads successfully"
    else
      print_warn "Could not locate main.js in page source"
    fi
  fi

  # Check styles (styles.css or styles.*.css)
  STYLES_URL=$(echo "$MAIN_HTML" | grep -oP 'href="[^"]*styles[^"]*\.css"' | head -1 | cut -d'"' -f2)
  if [ -n "$STYLES_URL" ]; then
    if curl -s -o /dev/null -w "%{http_code}" "http://localhost:$FRONTEND_PORT$STYLES_URL" | grep -q "200"; then
      print_pass "styles.css loads successfully"
    else
      print_fail "styles.css failed to load (404)"
    fi
  else
    # Check if inline styles exist (Angular sometimes inlines styles)
    if echo "$MAIN_HTML" | grep -q "<style"; then
      print_pass "Styles are inlined in HTML"
    else
      print_warn "Could not locate styles.css in page source"
    fi
  fi

  # Check for Material Icons font (either via CDN or bundled)
  if echo "$MAIN_HTML" | grep -qi "material.*icons\|fonts.googleapis"; then
    print_pass "Material Icons font reference found"
  else
    print_warn "Material Icons font link not found in HTML (may be loaded dynamically)"
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
      echo "> All build checks passed! Run Playwright tests for full browser validation."
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
      echo -e "${GREEN}All build checks passed! Run Playwright tests for full browser validation.${NC}"
      echo -e "  npm run e2e -- standalone-validation.spec.ts"
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
    echo "## Frontend Standalone Validation Results"
    echo ""
    echo "Generated: $(date -u +"%Y-%m-%d %H:%M:%S UTC")"
  else
    echo -e "${BLUE}MCP Everything - Frontend Standalone Validation${NC}"
    echo "Generated: $(date -u +"%Y-%m-%d %H:%M:%S UTC")"
  fi

  # Run build check first
  check_build || true

  if [ "$SKIP_BROWSER" = false ]; then
    # Start dev server and run checks
    check_dev_server || true
    check_browser_access || true
    check_assets || true
  else
    print_info "Skipping browser checks (--skip-browser flag)"
  fi

  print_summary

  # Exit with appropriate code
  if [ "$FAIL_COUNT" -gt 0 ]; then
    exit 1
  fi
  exit 0
}

main
