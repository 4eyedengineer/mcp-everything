#!/bin/bash

# Docker Cleanup Script for MCP Everything
# Automated cleanup of Docker resources to manage disk space

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
DRY_RUN=${DRY_RUN:-"false"}
AGGRESSIVE=${AGGRESSIVE:-"false"}
KEEP_DAYS=${KEEP_DAYS:-"7"}
KEEP_BASE_IMAGES=${KEEP_BASE_IMAGES:-"true"}

echo -e "${BLUE}🧹 Docker Cleanup for MCP Everything${NC}"
echo "Dry run: ${DRY_RUN}"
echo "Aggressive cleanup: ${AGGRESSIVE}"
echo "Keep resources newer than: ${KEEP_DAYS} days"
echo "Preserve base images: ${KEEP_BASE_IMAGES}"
echo ""

# Function to run command with dry run support
run_cmd() {
    local cmd=$1
    local description=$2

    echo -e "${YELLOW}${description}...${NC}"

    if [ "$DRY_RUN" = "true" ]; then
        echo "DRY RUN: $cmd"
        return 0
    else
        eval $cmd
        return $?
    fi
}

# Function to get size in human readable format
format_size() {
    local bytes=$1
    if [ $bytes -gt 1073741824 ]; then
        echo "$(($bytes / 1073741824))GB"
    elif [ $bytes -gt 1048576 ]; then
        echo "$(($bytes / 1048576))MB"
    elif [ $bytes -gt 1024 ]; then
        echo "$(($bytes / 1024))KB"
    else
        echo "${bytes}B"
    fi
}

# Get initial disk usage
initial_usage=$(docker system df --format "{{.TotalCount}} {{.Size}}" | head -1)
initial_size=$(echo $initial_usage | awk '{print $2}')

echo -e "${BLUE}📊 Current Docker Disk Usage${NC}"
docker system df

echo ""
echo -e "${BLUE}🔍 Analyzing Cleanup Candidates${NC}"

# Count resources to be cleaned
dangling_images=$(docker images -f "dangling=true" -q | wc -l)
old_containers=$(docker ps -a --filter "status=exited" --filter "created<${KEEP_DAYS}*24h" -q | wc -l)
unused_volumes=$(docker volume ls -f "dangling=true" -q | wc -l)

echo "Dangling images: $dangling_images"
echo "Old stopped containers: $old_containers"
echo "Unused volumes: $unused_volumes"

# Build cache info
if command -v docker &> /dev/null && docker version --format '{{.Server.Version}}' | grep -q '20\|21\|22\|23\|24'; then
    build_cache_size=$(docker system df --format "{{.BuildCache}}" | tail -1 | awk '{print $2}')
    echo "Build cache size: $build_cache_size"
fi

echo ""

# 1. Remove dangling images
if [ $dangling_images -gt 0 ]; then
    run_cmd "docker image prune -f" "Removing $dangling_images dangling images"
fi

# 2. Remove stopped containers
if [ $old_containers -gt 0 ]; then
    if [ "$AGGRESSIVE" = "true" ]; then
        run_cmd "docker container prune -f" "Removing all stopped containers"
    else
        run_cmd "docker container prune -f --filter \"until=${KEEP_DAYS}*24h\"" "Removing stopped containers older than $KEEP_DAYS days"
    fi
fi

# 3. Remove unused volumes
if [ $unused_volumes -gt 0 ]; then
    run_cmd "docker volume prune -f" "Removing $unused_volumes unused volumes"
fi

# 4. Clean build cache
if [ "$AGGRESSIVE" = "true" ]; then
    run_cmd "docker builder prune -f -a" "Removing all build cache"
else
    run_cmd "docker builder prune -f --filter \"until=${KEEP_DAYS}*24h\"" "Removing build cache older than $KEEP_DAYS days"
fi

# 5. Remove unused networks
run_cmd "docker network prune -f" "Removing unused networks"

# 6. Remove old images (if aggressive)
if [ "$AGGRESSIVE" = "true" ]; then
    echo -e "${YELLOW}Identifying old unused images...${NC}"

    # Get list of all images, excluding base images if KEEP_BASE_IMAGES is true
    if [ "$KEEP_BASE_IMAGES" = "true" ]; then
        old_images=$(docker images --filter "until=${KEEP_DAYS}*24h" --format "{{.Repository}}:{{.Tag}}" | grep -v "mcp-everything/" | head -20)
    else
        old_images=$(docker images --filter "until=${KEEP_DAYS}*24h" --format "{{.Repository}}:{{.Tag}}" | head -20)
    fi

    if [ ! -z "$old_images" ]; then
        for image in $old_images; do
            # Check if image is being used by any container
            if ! docker ps -a --filter "ancestor=$image" --format "{{.ID}}" | grep -q .; then
                run_cmd "docker rmi $image" "Removing unused image: $image"
            else
                echo "Skipping $image (in use by container)"
            fi
        done
    fi
fi

# 7. Clean up MCP Everything specific resources
echo ""
echo -e "${BLUE}🎯 MCP Everything Specific Cleanup${NC}"

# Remove failed build artifacts
failed_builds=$(docker images --filter "label=mcp-build-failed=true" -q | wc -l)
if [ $failed_builds -gt 0 ]; then
    run_cmd "docker rmi \$(docker images --filter \"label=mcp-build-failed=true\" -q)" "Removing $failed_builds failed build images"
fi

# Remove old generated server images (keep last 10 per server)
echo -e "${YELLOW}Cleaning up old generated server images...${NC}"
for server_name in $(docker images --format "{{.Repository}}" | grep -E "^[a-z0-9-]+$" | sort | uniq); do
    image_count=$(docker images $server_name --format "{{.Tag}}" | wc -l)
    if [ $image_count -gt 10 ]; then
        old_tags=$(docker images $server_name --format "{{.Tag}}" | tail -n +11)
        for tag in $old_tags; do
            run_cmd "docker rmi ${server_name}:${tag}" "Removing old server image: ${server_name}:${tag}"
        done
    fi
done

# 8. System-wide cleanup
echo ""
echo -e "${BLUE}🔧 Final System Cleanup${NC}"

if [ "$AGGRESSIVE" = "true" ]; then
    run_cmd "docker system prune -f -a --volumes" "Aggressive system-wide cleanup"
else
    run_cmd "docker system prune -f" "Standard system cleanup"
fi

# Get final disk usage
echo ""
echo -e "${BLUE}📊 Cleanup Results${NC}"

if [ "$DRY_RUN" = "false" ]; then
    final_usage=$(docker system df --format "{{.TotalCount}} {{.Size}}" | head -1)
    final_size=$(echo $final_usage | awk '{print $2}')

    echo "Before cleanup: $initial_size"
    echo "After cleanup: $final_size"

    # Calculate space saved (simplified - would need actual byte values for accurate calculation)
    echo ""
    docker system df
else
    echo "Dry run completed. No changes made."
fi

# Recommendations
echo ""
echo -e "${BLUE}💡 Recommendations${NC}"

current_images=$(docker images -q | wc -l)
if [ $current_images -gt 50 ]; then
    echo "• Consider more frequent cleanup - you have $current_images images"
fi

current_containers=$(docker ps -a -q | wc -l)
if [ $current_containers -gt 20 ]; then
    echo "• Consider removing old containers - you have $current_containers containers"
fi

# Check available disk space
available_space=$(df /var/lib/docker 2>/dev/null | tail -1 | awk '{print $4}' || echo "unknown")
if [ "$available_space" != "unknown" ] && [ $available_space -lt 5242880 ]; then  # Less than 5GB
    echo "• Low disk space warning: Consider aggressive cleanup or expanding storage"
fi

echo "• Schedule regular cleanup with: 0 3 * * * /path/to/docker-cleanup.sh"
echo "• Monitor disk usage with: docker system df"
echo "• Use dry run first: DRY_RUN=true ./scripts/docker-cleanup.sh"

echo ""
if [ "$DRY_RUN" = "false" ]; then
    echo -e "${GREEN}🎉 Docker cleanup completed successfully!${NC}"
else
    echo -e "${YELLOW}🔍 Dry run completed. Use DRY_RUN=false to execute cleanup.${NC}"
fi