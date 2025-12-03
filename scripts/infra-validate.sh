#!/bin/bash
#
# Infrastructure Validation Script for MCP Everything
# Validates all infrastructure components per Issue #87
#
# Usage: ./scripts/infra-validate.sh [--markdown] [--skip-kind]
#
# Options:
#   --markdown    Output results in markdown format (for GitHub issue)
#   --skip-kind   Skip KinD cluster validation
#

set -e

# Colors for terminal output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
REQUIRED_NODE_VERSION=18
REQUIRED_NPM_VERSION=9
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-postgres}"
POSTGRES_DB="${POSTGRES_DB:-mcp_everything}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"

# Counters
PASS_COUNT=0
FAIL_COUNT=0
WARN_COUNT=0

# Options
MARKDOWN_OUTPUT=false
SKIP_KIND=false

# Parse arguments
for arg in "$@"; do
  case $arg in
    --markdown)
      MARKDOWN_OUTPUT=true
      shift
      ;;
    --skip-kind)
      SKIP_KIND=true
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

# ============================================================
# 1.1 Node.js & npm Validation
# ============================================================
check_node_npm() {
  print_header "1.1 Node.js & npm"

  # Check Node.js
  if command -v node &> /dev/null; then
    NODE_VERSION=$(node --version | sed 's/v//')
    NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)

    if [ "$NODE_MAJOR" -ge "$REQUIRED_NODE_VERSION" ]; then
      print_pass "Node.js version is $NODE_VERSION (>= $REQUIRED_NODE_VERSION required)"
    else
      print_fail "Node.js version $NODE_VERSION is below required $REQUIRED_NODE_VERSION+" "Install Node.js 18+ or 20+ using nvm or your package manager"
    fi
  else
    print_fail "Node.js is not installed" "Install Node.js from https://nodejs.org or use nvm"
  fi

  # Check npm
  if command -v npm &> /dev/null; then
    NPM_VERSION=$(npm --version)
    NPM_MAJOR=$(echo "$NPM_VERSION" | cut -d. -f1)

    if [ "$NPM_MAJOR" -ge "$REQUIRED_NPM_VERSION" ]; then
      print_pass "npm version is $NPM_VERSION (>= $REQUIRED_NPM_VERSION required)"
    else
      print_fail "npm version $NPM_VERSION is below required $REQUIRED_NPM_VERSION+" "Upgrade npm: npm install -g npm@latest"
    fi
  else
    print_fail "npm is not installed" "npm should be installed with Node.js"
  fi
}

# ============================================================
# 1.2 Docker Validation
# ============================================================
check_docker() {
  print_header "1.2 Docker"

  # Check Docker installation
  if command -v docker &> /dev/null; then
    DOCKER_VERSION=$(docker --version)
    print_pass "Docker is installed ($DOCKER_VERSION)"
  else
    print_fail "Docker is not installed" "Install Docker from https://docs.docker.com/get-docker/"
    return
  fi

  # Check Docker daemon
  if docker ps &> /dev/null; then
    print_pass "Docker daemon is running"
  else
    print_fail "Docker daemon is not running" "Start Docker: sudo systemctl start docker (Linux) or open Docker Desktop (Mac/Windows)"
  fi
}

# ============================================================
# 1.3 Dependencies Validation
# ============================================================
check_dependencies() {
  print_header "1.3 Dependencies"

  # Find project root (handle both worktree and main repo)
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

  # Check if we can run npm install
  if [ -f "$PROJECT_ROOT/package.json" ]; then
    print_info "Running npm install in $PROJECT_ROOT..."

    cd "$PROJECT_ROOT"
    if npm install 2>&1 | grep -q "npm error\|ERR!"; then
      print_fail "npm install has errors" "Run: npm cache clean --force && rm -rf node_modules && npm install"
    else
      print_pass "npm install completes without errors"
    fi

    # Check for critical peer dependency warnings
    PEER_WARNINGS=$(npm install 2>&1 | grep -c "peer dep\|WARN.*peer" || true)
    if [ "$PEER_WARNINGS" -gt 5 ]; then
      print_warn "Found $PEER_WARNINGS peer dependency warnings (review with npm ls)"
    else
      print_pass "No critical peer dependency warnings"
    fi
  else
    print_fail "package.json not found in project root" "Ensure you're in the correct directory"
  fi
}

# ============================================================
# 1.4 PostgreSQL Container Validation
# ============================================================
check_postgres_container() {
  print_header "1.4 PostgreSQL Container"

  # Check if postgres container exists and is running (match any container with postgres in name)
  POSTGRES_RUNNING=$(docker ps --filter "status=running" --format "{{.Names}}" | grep -i postgres | head -1)

  if [ -n "$POSTGRES_RUNNING" ]; then
    print_pass "PostgreSQL container ($POSTGRES_RUNNING) is running"
    return 0
  fi

  # Try to start via docker-compose
  print_info "Attempting to start PostgreSQL via docker compose..."

  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

  if [ -f "$PROJECT_ROOT/docker-compose.yml" ]; then
    cd "$PROJECT_ROOT"
    docker compose up -d postgres 2>&1 || true
    sleep 5

    POSTGRES_RUNNING=$(docker ps --filter "status=running" --format "{{.Names}}" | grep -i postgres | head -1)
    if [ -n "$POSTGRES_RUNNING" ]; then
      print_pass "PostgreSQL container started successfully ($POSTGRES_RUNNING)"
      return 0
    else
      # Check if container exists but failed
      POSTGRES_FAILED=$(docker ps -a --filter "status=exited" --format "{{.Names}}" | grep -i postgres | head -1)
      if [ -n "$POSTGRES_FAILED" ]; then
        print_info "Container failed to start. Checking logs..."
        docker logs "$POSTGRES_FAILED" 2>&1 | tail -5
      fi
    fi
  fi

  # Try direct docker run (only if no container exists)
  if ! docker ps -a --format "{{.Names}}" | grep -qi "mcp.*postgres"; then
    print_info "Attempting direct Docker run..."
    if docker run -d --name mcp-postgres \
      -e POSTGRES_USER=$POSTGRES_USER \
      -e POSTGRES_PASSWORD=$POSTGRES_PASSWORD \
      -e POSTGRES_DB=$POSTGRES_DB \
      -p $POSTGRES_PORT:5432 \
      postgres:15 2>&1; then
      sleep 5
      if docker ps --filter "name=mcp-postgres" --filter "status=running" -q | grep -q .; then
        print_pass "PostgreSQL container started via docker run"
        return 0
      fi
    fi
  fi

  print_fail "Could not start PostgreSQL container" "Check docker logs for errors, then: docker compose up -d postgres"
  return 1
}

# ============================================================
# 1.5 Database Connection Validation
# ============================================================
check_database_connection() {
  print_header "1.5 Database Connection"

  # Try psql first
  if command -v psql &> /dev/null; then
    if PGPASSWORD=$POSTGRES_PASSWORD psql -h localhost -U $POSTGRES_USER -d $POSTGRES_DB -p $POSTGRES_PORT -c "SELECT 1" &> /dev/null; then
      print_pass "Can connect to database via psql"
      print_pass "Query returns successfully"
      return 0
    fi
  fi

  # Try via docker exec
  POSTGRES_CONTAINER=$(docker ps --filter "name=postgres" --filter "status=running" --format "{{.Names}}" | head -1)
  if [ -n "$POSTGRES_CONTAINER" ]; then
    if docker exec "$POSTGRES_CONTAINER" psql -U $POSTGRES_USER -d $POSTGRES_DB -c "SELECT 1" &> /dev/null; then
      print_pass "Can connect to database via docker exec"
      print_pass "Query returns successfully"
      return 0
    fi
  fi

  print_fail "Cannot connect to database" "Ensure PostgreSQL is running and credentials are correct (user: $POSTGRES_USER, db: $POSTGRES_DB)"
  return 1
}

# ============================================================
# 1.6 Environment Variables Validation
# ============================================================
check_environment() {
  print_header "1.6 Environment Variables"

  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
  BACKEND_ENV="$PROJECT_ROOT/packages/backend/.env"
  ROOT_ENV="$PROJECT_ROOT/.env"

  # Load .env if it exists
  if [ -f "$BACKEND_ENV" ]; then
    source "$BACKEND_ENV" 2>/dev/null || true
    print_info "Loaded environment from $BACKEND_ENV"
  elif [ -f "$ROOT_ENV" ]; then
    source "$ROOT_ENV" 2>/dev/null || true
    print_info "Loaded environment from $ROOT_ENV"
  else
    print_fail ".env file not found" "Copy .env.example to .env: cp packages/backend/.env.example packages/backend/.env"
    return 1
  fi

  # Check DATABASE_URL or individual DB vars
  if [ -n "$DATABASE_URL" ] || ([ -n "$DATABASE_HOST" ] && [ -n "$DATABASE_PORT" ]); then
    print_pass "DATABASE_URL or individual DB vars configured"
  else
    print_fail "DATABASE_URL or DB configuration missing" "Set DATABASE_URL=postgresql://mcp:mcp@localhost:5432/mcp_everything"
  fi

  # Check ANTHROPIC_API_KEY
  if [ -n "$ANTHROPIC_API_KEY" ] && [ "$ANTHROPIC_API_KEY" != "sk-ant-your-key-here" ]; then
    if [[ "$ANTHROPIC_API_KEY" == sk-ant-* ]]; then
      print_pass "ANTHROPIC_API_KEY is configured (valid format)"
    else
      print_warn "ANTHROPIC_API_KEY is set but format looks unusual"
    fi
  else
    print_fail "ANTHROPIC_API_KEY is missing or placeholder" "Get API key from https://console.anthropic.com"
  fi

  # Check GITHUB_TOKEN (optional)
  if [ -n "$GITHUB_TOKEN" ] && [ "$GITHUB_TOKEN" != "ghp_your-token-here" ]; then
    if [[ "$GITHUB_TOKEN" == ghp_* ]] || [[ "$GITHUB_TOKEN" == github_pat_* ]]; then
      print_pass "GITHUB_TOKEN is configured (optional, for GitHub features)"
    else
      print_warn "GITHUB_TOKEN is set but format looks unusual"
    fi
  else
    print_warn "GITHUB_TOKEN not configured (optional - needed for GitHub features)"
  fi
}

# ============================================================
# 1.7 KinD Validation (Optional)
# ============================================================
check_kind() {
  print_header "1.7 KinD (Kubernetes in Docker)"

  if [ "$SKIP_KIND" = true ]; then
    print_info "Skipping KinD validation (--skip-kind flag)"
    return 0
  fi

  # Check if kind is installed
  if ! command -v kind &> /dev/null; then
    print_warn "KinD not installed (optional - for hosting tests)"
    print_info "Install: https://kind.sigs.k8s.io/docs/user/quick-start/#installation"
    return 0
  fi

  # Check if kubectl is installed
  if ! command -v kubectl &> /dev/null; then
    print_warn "kubectl not installed (required for KinD)"
    print_info "Install: https://kubernetes.io/docs/tasks/tools/install-kubectl/"
    return 0
  fi

  # Check if cluster exists
  if kind get clusters 2>/dev/null | grep -q "mcp-local"; then
    print_pass "KinD cluster 'mcp-local' exists"

    # Check cluster connectivity
    if kubectl cluster-info --context kind-mcp-local &> /dev/null; then
      print_pass "KinD cluster is accessible"
    else
      print_fail "Cannot connect to KinD cluster" "Try: kind delete cluster --name mcp-local && ./scripts/kind/setup.sh"
    fi
  else
    print_warn "KinD cluster 'mcp-local' not found"
    print_info "To set up: ./scripts/kind/setup.sh"
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
      echo "> All required checks passed! Ready to proceed to Layer 2."
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
      echo -e "${GREEN}All required checks passed! Ready to proceed to Layer 2.${NC}"
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
    echo "## Infrastructure Validation Results"
    echo ""
    echo "Generated: $(date -u +"%Y-%m-%d %H:%M:%S UTC")"
  else
    echo -e "${BLUE}MCP Everything - Infrastructure Validation${NC}"
    echo "Generated: $(date -u +"%Y-%m-%d %H:%M:%S UTC")"
  fi

  check_node_npm
  check_docker
  check_dependencies
  check_postgres_container
  check_database_connection
  check_environment
  check_kind

  print_summary

  # Exit with appropriate code
  if [ "$FAIL_COUNT" -gt 0 ]; then
    exit 1
  fi
  exit 0
}

main
