#!/bin/bash

# Build Base Images Script for MCP Everything
# This script builds all base Docker images with optimized caching

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
REGISTRY=${DOCKER_REGISTRY:-""}
NAMESPACE=${DOCKER_NAMESPACE:-"mcp-everything"}
BUILD_PARALLEL=${BUILD_PARALLEL:-"true"}
PUSH_IMAGES=${PUSH_IMAGES:-"false"}
CACHE_FROM=${CACHE_FROM:-"true"}

# Base images to build
declare -a BASE_IMAGES=(
    "node-alpine:docker/base-images/node-alpine.Dockerfile"
    "node-slim:docker/base-images/node-slim.Dockerfile"
    "python-alpine:docker/base-images/python-alpine.Dockerfile"
)

echo -e "${BLUE}🐳 Building MCP Everything Base Images${NC}"
echo "Registry: ${REGISTRY:-"local"}"
echo "Namespace: ${NAMESPACE}"
echo "Parallel builds: ${BUILD_PARALLEL}"
echo "Push to registry: ${PUSH_IMAGES}"
echo ""

# Function to build a single image
build_image() {
    local image_def=$1
    local image_name=$(echo $image_def | cut -d: -f1)
    local dockerfile=$(echo $image_def | cut -d: -f2)

    local full_tag="${NAMESPACE}/${image_name}:latest"
    if [ ! -z "$REGISTRY" ]; then
        full_tag="${REGISTRY}/${full_tag}"
    fi

    echo -e "${YELLOW}Building ${image_name}...${NC}"

    # Build arguments
    local build_args=""
    if [ "$CACHE_FROM" = "true" ]; then
        build_args="--cache-from ${full_tag}"
    fi

    # Build command
    local build_cmd="docker build \
        -f ${dockerfile} \
        -t ${full_tag} \
        ${build_args} \
        --build-arg BUILDKIT_INLINE_CACHE=1 \
        ."

    echo "Executing: $build_cmd"

    if eval $build_cmd; then
        echo -e "${GREEN}✅ Successfully built ${image_name}${NC}"

        # Tag as cache image
        docker tag ${full_tag} ${NAMESPACE}/${image_name}:cache

        # Push if requested
        if [ "$PUSH_IMAGES" = "true" ]; then
            echo -e "${YELLOW}Pushing ${image_name}...${NC}"
            docker push ${full_tag}
            docker push ${NAMESPACE}/${image_name}:cache
            echo -e "${GREEN}✅ Successfully pushed ${image_name}${NC}"
        fi

        return 0
    else
        echo -e "${RED}❌ Failed to build ${image_name}${NC}"
        return 1
    fi
}

# Function to get image size
get_image_size() {
    local image_tag=$1
    docker images --format "table {{.Size}}" --filter "reference=${image_tag}" | tail -n 1
}

# Function to build images in parallel
build_parallel() {
    local pids=()
    local results=()

    for image_def in "${BASE_IMAGES[@]}"; do
        build_image "$image_def" &
        pids+=($!)
    done

    # Wait for all builds to complete
    for i in "${!pids[@]}"; do
        if wait ${pids[$i]}; then
            results+=("SUCCESS")
        else
            results+=("FAILED")
        fi
    done

    return 0
}

# Function to build images sequentially
build_sequential() {
    local failed=0

    for image_def in "${BASE_IMAGES[@]}"; do
        if ! build_image "$image_def"; then
            failed=$((failed + 1))
        fi
    done

    return $failed
}

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    echo -e "${RED}❌ Docker is not running or accessible${NC}"
    exit 1
fi

# Check if Dockerfiles exist
for image_def in "${BASE_IMAGES[@]}"; do
    dockerfile=$(echo $image_def | cut -d: -f2)
    if [ ! -f "$dockerfile" ]; then
        echo -e "${RED}❌ Dockerfile not found: $dockerfile${NC}"
        exit 1
    fi
done

# Enable BuildKit
export DOCKER_BUILDKIT=1

# Start building
start_time=$(date +%s)

if [ "$BUILD_PARALLEL" = "true" ]; then
    echo -e "${BLUE}Building images in parallel...${NC}"
    build_parallel
    build_result=$?
else
    echo -e "${BLUE}Building images sequentially...${NC}"
    build_sequential
    build_result=$?
fi

end_time=$(date +%s)
duration=$((end_time - start_time))

echo ""
echo -e "${BLUE}📊 Build Summary${NC}"
echo "Duration: ${duration}s"

# Display image sizes
echo ""
echo -e "${BLUE}📦 Image Sizes${NC}"
for image_def in "${BASE_IMAGES[@]}"; do
    image_name=$(echo $image_def | cut -d: -f1)
    full_tag="${NAMESPACE}/${image_name}:latest"
    if [ ! -z "$REGISTRY" ]; then
        full_tag="${REGISTRY}/${full_tag}"
    fi

    size=$(get_image_size "$full_tag")
    echo "${image_name}: ${size}"
done

# Check for unused images and suggest cleanup
echo ""
echo -e "${BLUE}🧹 Cleanup Suggestions${NC}"
dangling_images=$(docker images -f "dangling=true" -q | wc -l)
if [ $dangling_images -gt 0 ]; then
    echo "Found $dangling_images dangling images. Clean up with:"
    echo "  docker image prune -f"
fi

# Show cache usage
echo ""
echo -e "${BLUE}💾 Docker Cache Usage${NC}"
docker system df

if [ $build_result -eq 0 ]; then
    echo ""
    echo -e "${GREEN}🎉 All base images built successfully!${NC}"

    if [ "$PUSH_IMAGES" = "false" ]; then
        echo ""
        echo -e "${YELLOW}💡 To push images to registry, run:${NC}"
        echo "  PUSH_IMAGES=true ./scripts/build-base-images.sh"
    fi
else
    echo ""
    echo -e "${RED}❌ Some images failed to build. Check logs above.${NC}"
    exit 1
fi