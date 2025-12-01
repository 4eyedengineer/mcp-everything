#!/bin/bash

# Docker Operations Script for MCP Everything
# Unified script for all Docker operations

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
NC='\033[0m' # No Color

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Functions
show_help() {
    echo -e "${BLUE}🐳 MCP Everything Docker Operations${NC}"
    echo ""
    echo "Usage: $0 [COMMAND] [OPTIONS]"
    echo ""
    echo "Commands:"
    echo -e "  ${GREEN}init${NC}          Initialize Docker environment"
    echo -e "  ${GREEN}build-base${NC}    Build base images"
    echo -e "  ${GREEN}build${NC}         Build MCP server(s)"
    echo -e "  ${GREEN}test${NC}          Test containers"
    echo -e "  ${GREEN}deploy${NC}        Deploy to registry"
    echo -e "  ${GREEN}cleanup${NC}       Clean up Docker resources"
    echo -e "  ${GREEN}status${NC}        Show Docker status"
    echo -e "  ${GREEN}logs${NC}          Show container logs"
    echo -e "  ${GREEN}shell${NC}         Access container shell"
    echo ""
    echo "Options:"
    echo "  -h, --help          Show this help"
    echo "  -v, --verbose       Verbose output"
    echo "  -d, --dry-run       Dry run mode"
    echo "  -f, --force         Force operation"
    echo "  --parallel          Enable parallel operations"
    echo "  --no-cache          Disable cache"
    echo ""
    echo "Examples:"
    echo "  $0 init                           # Initialize Docker environment"
    echo "  $0 build-base --parallel          # Build base images in parallel"
    echo "  $0 build my-server --no-cache     # Build specific server without cache"
    echo "  $0 test my-server:latest          # Test specific container"
    echo "  $0 cleanup --dry-run              # Show what would be cleaned"
    echo "  $0 status                         # Show current status"
}

init_docker() {
    echo -e "${BLUE}🚀 Initializing Docker Environment${NC}"

    # Check if Docker is running
    if ! docker info > /dev/null 2>&1; then
        echo -e "${RED}❌ Docker is not running. Please start Docker first.${NC}"
        exit 1
    fi

    # Create necessary directories
    mkdir -p "$PROJECT_ROOT/generated-servers"
    mkdir -p "$PROJECT_ROOT/docker/cache"
    mkdir -p "$PROJECT_ROOT/logs/docker"

    # Enable BuildKit
    export DOCKER_BUILDKIT=1
    echo "DOCKER_BUILDKIT=1" >> "$PROJECT_ROOT/.env" 2>/dev/null || true

    # Set up Docker daemon configuration for better performance
    if [ -w "/etc/docker" ]; then
        echo -e "${YELLOW}Optimizing Docker daemon configuration...${NC}"
        cat > /tmp/docker-daemon.json << EOF
{
  "features": {
    "buildkit": true
  },
  "builder": {
    "gc": {
      "enabled": true,
      "defaultKeepStorage": "10GB"
    }
  }
}
EOF
        sudo cp /tmp/docker-daemon.json /etc/docker/daemon.json 2>/dev/null || true
    fi

    # Verify initialization
    docker version
    docker system df

    echo -e "${GREEN}✅ Docker environment initialized successfully${NC}"
}

build_base_images() {
    echo -e "${BLUE}🏗️ Building Base Images${NC}"

    local parallel=${PARALLEL:-false}
    local push=${PUSH_IMAGES:-false}

    if [ "$parallel" = "true" ]; then
        BUILD_PARALLEL=true PUSH_IMAGES=$push "$SCRIPT_DIR/build-base-images.sh"
    else
        BUILD_PARALLEL=false PUSH_IMAGES=$push "$SCRIPT_DIR/build-base-images.sh"
    fi
}

build_server() {
    local server_name=$1
    echo -e "${BLUE}🔨 Building MCP Server: ${server_name}${NC}"

    if [ -z "$server_name" ]; then
        echo -e "${RED}❌ Server name required${NC}"
        exit 1
    fi

    local no_cache=${NO_CACHE:-false}
    local build_args=""

    if [ "$no_cache" = "true" ]; then
        build_args="--no-cache"
    fi

    # Check if server directory exists
    local server_path="$PROJECT_ROOT/generated-servers/$server_name"
    if [ ! -d "$server_path" ]; then
        echo -e "${RED}❌ Server directory not found: $server_path${NC}"
        exit 1
    fi

    # Build the server
    cd "$server_path"
    docker build $build_args -t "$server_name:latest" .

    echo -e "${GREEN}✅ Server built successfully: ${server_name}:latest${NC}"
}

test_container() {
    local image_tag=$1
    echo -e "${BLUE}🧪 Testing Container: ${image_tag}${NC}"

    if [ -z "$image_tag" ]; then
        echo -e "${RED}❌ Image tag required${NC}"
        exit 1
    fi

    # Quick smoke test
    echo "Running smoke test..."
    if docker run --rm "$image_tag" --version; then
        echo -e "${GREEN}✅ Smoke test passed${NC}"
    else
        echo -e "${RED}❌ Smoke test failed${NC}"
        exit 1
    fi

    # Health check test
    echo "Running health check test..."
    local container_id=$(docker run -d -p 0:3000 "$image_tag")

    # Wait for container to start
    sleep 5

    # Get the mapped port
    local host_port=$(docker port "$container_id" 3000 | cut -d: -f2)

    # Test health endpoint
    if curl -f "http://localhost:$host_port/health" > /dev/null 2>&1; then
        echo -e "${GREEN}✅ Health check passed${NC}"
    else
        echo -e "${YELLOW}⚠️ Health check failed (container may not have health endpoint)${NC}"
    fi

    # Cleanup test container
    docker stop "$container_id" > /dev/null
    docker rm "$container_id" > /dev/null

    echo -e "${GREEN}✅ Container tests completed${NC}"
}

deploy_to_registry() {
    local image_tag=$1
    echo -e "${BLUE}🚀 Deploying to Registry: ${image_tag}${NC}"

    if [ -z "$image_tag" ]; then
        echo -e "${RED}❌ Image tag required${NC}"
        exit 1
    fi

    # Check if logged in to registry
    if ! docker info | grep -q "Username:"; then
        echo -e "${YELLOW}⚠️ Not logged in to Docker registry. Use 'docker login' first.${NC}"
        exit 1
    fi

    # Tag for registry
    local registry_tag="$DOCKER_REGISTRY/$DOCKER_NAMESPACE/$image_tag"
    docker tag "$image_tag" "$registry_tag"

    # Push to registry
    docker push "$registry_tag"

    echo -e "${GREEN}✅ Successfully deployed: ${registry_tag}${NC}"
}

cleanup_docker() {
    echo -e "${BLUE}🧹 Cleaning Up Docker Resources${NC}"

    local dry_run=${DRY_RUN:-false}
    local aggressive=${AGGRESSIVE:-false}

    if [ "$aggressive" = "true" ]; then
        AGGRESSIVE=true DRY_RUN=$dry_run "$SCRIPT_DIR/docker-cleanup.sh"
    else
        DRY_RUN=$dry_run "$SCRIPT_DIR/docker-cleanup.sh"
    fi
}

show_status() {
    echo -e "${BLUE}📊 Docker Status${NC}"
    echo ""

    # Docker system info
    echo -e "${PURPLE}System Info:${NC}"
    docker system df
    echo ""

    # Running containers
    echo -e "${PURPLE}Running Containers:${NC}"
    docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}"
    echo ""

    # MCP Images
    echo -e "${PURPLE}MCP Images:${NC}"
    docker images --filter "reference=*mcp*" --format "table {{.Repository}}\t{{.Tag}}\t{{.Size}}\t{{.CreatedAt}}"
    echo ""

    # Build cache
    echo -e "${PURPLE}Build Cache:${NC}"
    docker system df --format "{{.BuildCache}}"
    echo ""

    # Recent builds (from logs if available)
    local log_file="$PROJECT_ROOT/logs/docker/builds.log"
    if [ -f "$log_file" ]; then
        echo -e "${PURPLE}Recent Builds:${NC}"
        tail -5 "$log_file"
    fi
}

show_logs() {
    local container_name=$1

    if [ -z "$container_name" ]; then
        echo -e "${BLUE}📋 Available Containers:${NC}"
        docker ps --format "{{.Names}}"
        return
    fi

    echo -e "${BLUE}📋 Logs for: ${container_name}${NC}"
    docker logs --tail 100 -f "$container_name"
}

container_shell() {
    local container_name=$1

    if [ -z "$container_name" ]; then
        echo -e "${BLUE}💻 Available Containers:${NC}"
        docker ps --format "{{.Names}}"
        return
    fi

    echo -e "${BLUE}💻 Accessing shell: ${container_name}${NC}"

    # Try different shells
    if docker exec -it "$container_name" /bin/bash 2>/dev/null; then
        :
    elif docker exec -it "$container_name" /bin/sh 2>/dev/null; then
        :
    else
        echo -e "${RED}❌ Could not access shell for ${container_name}${NC}"
        exit 1
    fi
}

# Parse command line arguments
COMMAND=""
VERBOSE=false
DRY_RUN=false
FORCE=false
PARALLEL=false
NO_CACHE=false

while [[ $# -gt 0 ]]; do
    case $1 in
        -h|--help)
            show_help
            exit 0
            ;;
        -v|--verbose)
            VERBOSE=true
            set -x
            shift
            ;;
        -d|--dry-run)
            DRY_RUN=true
            shift
            ;;
        -f|--force)
            FORCE=true
            shift
            ;;
        --parallel)
            PARALLEL=true
            shift
            ;;
        --no-cache)
            NO_CACHE=true
            shift
            ;;
        init|build-base|build|test|deploy|cleanup|status|logs|shell)
            COMMAND=$1
            shift
            ;;
        *)
            if [ -z "$COMMAND" ]; then
                echo -e "${RED}❌ Unknown command: $1${NC}"
                show_help
                exit 1
            else
                # Remaining arguments are parameters for the command
                break
            fi
            ;;
    esac
done

# Execute command
case $COMMAND in
    init)
        init_docker
        ;;
    build-base)
        build_base_images
        ;;
    build)
        build_server "$1"
        ;;
    test)
        test_container "$1"
        ;;
    deploy)
        deploy_to_registry "$1"
        ;;
    cleanup)
        cleanup_docker
        ;;
    status)
        show_status
        ;;
    logs)
        show_logs "$1"
        ;;
    shell)
        container_shell "$1"
        ;;
    "")
        echo -e "${RED}❌ No command specified${NC}"
        show_help
        exit 1
        ;;
    *)
        echo -e "${RED}❌ Unknown command: $COMMAND${NC}"
        show_help
        exit 1
        ;;
esac