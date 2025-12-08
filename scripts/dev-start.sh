#!/bin/bash
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🚀 Starting MCP Everything Development Environment${NC}"
echo ""

# Get script directory and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Change to project root
cd "$PROJECT_ROOT"

# Load .env file if it exists
if [ -f .env ]; then
    echo -e "${GREEN}✓ Loading environment from .env${NC}"
    set -a
    source .env
    set +a
else
    echo -e "${YELLOW}⚠ No .env file found. Checking for required environment variables...${NC}"
fi

# Check for required environment variables
MISSING_VARS=()

if [ -z "$ANTHROPIC_API_KEY" ]; then
    MISSING_VARS+=("ANTHROPIC_API_KEY")
fi

if [ -z "$GITHUB_TOKEN" ]; then
    MISSING_VARS+=("GITHUB_TOKEN")
fi

if [ ${#MISSING_VARS[@]} -ne 0 ]; then
    echo -e "${RED}❌ Missing required environment variables:${NC}"
    for var in "${MISSING_VARS[@]}"; do
        echo -e "   - $var"
    done
    echo ""
    echo -e "${YELLOW}Please copy .env.example to .env and fill in the required values:${NC}"
    echo -e "   cp .env.example .env"
    echo -e "   # Edit .env with your API keys"
    exit 1
fi

echo -e "${GREEN}✓ Required environment variables are set${NC}"

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    echo -e "${RED}❌ Docker is not running. Please start Docker and try again.${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Docker is running${NC}"

# Start services
echo ""
echo -e "${BLUE}📦 Starting Docker services...${NC}"
docker-compose -f docker/docker-compose.dev.yml up -d --build

# Wait for services to be healthy
echo ""
echo -e "${BLUE}⏳ Waiting for services to be healthy...${NC}"

# Function to check service health
check_health() {
    local service=$1
    local max_attempts=$2
    local attempt=1

    while [ $attempt -le $max_attempts ]; do
        if docker-compose -f docker/docker-compose.dev.yml ps $service | grep -q "healthy"; then
            return 0
        fi
        echo -e "   Waiting for $service... (attempt $attempt/$max_attempts)"
        sleep 3
        attempt=$((attempt + 1))
    done
    return 1
}

# Check PostgreSQL
echo -e "${YELLOW}   Checking PostgreSQL...${NC}"
if check_health postgres 20; then
    echo -e "${GREEN}   ✓ PostgreSQL is healthy${NC}"
else
    echo -e "${RED}   ❌ PostgreSQL failed to become healthy${NC}"
    echo -e "   Check logs: docker-compose -f docker/docker-compose.dev.yml logs postgres"
    exit 1
fi

# Check Redis
echo -e "${YELLOW}   Checking Redis...${NC}"
if check_health redis 10; then
    echo -e "${GREEN}   ✓ Redis is healthy${NC}"
else
    echo -e "${RED}   ❌ Redis failed to become healthy${NC}"
    echo -e "   Check logs: docker-compose -f docker/docker-compose.dev.yml logs redis"
    exit 1
fi

# Check Backend
echo -e "${YELLOW}   Checking Backend...${NC}"
if check_health backend 30; then
    echo -e "${GREEN}   ✓ Backend is healthy${NC}"
else
    echo -e "${RED}   ❌ Backend failed to become healthy${NC}"
    echo -e "   Check logs: docker-compose -f docker/docker-compose.dev.yml logs backend"
    exit 1
fi

# Run migrations
echo ""
echo -e "${BLUE}🗄️ Running database migrations...${NC}"
if docker-compose -f docker/docker-compose.dev.yml exec -T backend npm run migration:run --workspace=@mcp-everything/backend 2>/dev/null; then
    echo -e "${GREEN}✓ Migrations completed${NC}"
else
    echo -e "${YELLOW}⚠ Migration command not found or no migrations to run${NC}"
fi

# Show status
echo ""
echo -e "${GREEN}✅ Development environment ready!${NC}"
echo ""
echo -e "${BLUE}📍 Services:${NC}"
echo -e "   Frontend:  ${GREEN}http://localhost:4200${NC}"
echo -e "   Backend:   ${GREEN}http://localhost:3000${NC}"
echo -e "   API Docs:  ${GREEN}http://localhost:3000/api${NC}"
echo -e "   Database:  ${GREEN}postgresql://mcp:mcp_secret@localhost:5432/mcp_everything${NC}"
echo -e "   Redis:     ${GREEN}redis://localhost:6379${NC}"
echo -e "   Registry:  ${GREEN}http://localhost:5001${NC}"
echo ""
echo -e "${BLUE}📋 Useful commands:${NC}"
echo -e "   View logs:     ${YELLOW}npm run dev:logs${NC}"
echo -e "   Stop:          ${YELLOW}npm run dev:down${NC}"
echo -e "   Reset DB:      ${YELLOW}npm run dev:reset${NC}"
echo -e "   Backend logs:  ${YELLOW}docker-compose -f docker/docker-compose.dev.yml logs -f backend${NC}"
echo -e "   Frontend logs: ${YELLOW}docker-compose -f docker/docker-compose.dev.yml logs -f frontend${NC}"
echo ""
