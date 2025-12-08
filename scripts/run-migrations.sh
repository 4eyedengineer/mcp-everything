#!/bin/bash
#
# Run Database Migrations
#
# This script executes all pending TypeORM migrations for the MCP Everything backend.
# It waits for PostgreSQL to be ready before running migrations.
#
# Usage:
#   ./scripts/run-migrations.sh           # Run with default settings
#   ./scripts/run-migrations.sh --seed    # Run migrations and seed data
#
# Environment Variables:
#   DATABASE_HOST     - PostgreSQL host (default: localhost)
#   DATABASE_PORT     - PostgreSQL port (default: 5432)
#   DATABASE_USER     - PostgreSQL user (default: postgres)
#   DATABASE_PASSWORD - PostgreSQL password (default: postgres)
#   DATABASE_NAME     - PostgreSQL database (default: mcp_everything)
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default values
DB_HOST="${DATABASE_HOST:-localhost}"
DB_PORT="${DATABASE_PORT:-5432}"
DB_USER="${DATABASE_USER:-postgres}"
DB_NAME="${DATABASE_NAME:-mcp_everything}"

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BACKEND_DIR="$PROJECT_ROOT/packages/backend"

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  MCP Everything Database Migrations${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# Check if we're in the right directory
if [ ! -d "$BACKEND_DIR" ]; then
    echo -e "${RED}Error: Backend directory not found at $BACKEND_DIR${NC}"
    exit 1
fi

cd "$BACKEND_DIR"

# Function to check if PostgreSQL is ready
wait_for_postgres() {
    echo -e "${YELLOW}Waiting for PostgreSQL at $DB_HOST:$DB_PORT...${NC}"

    local max_attempts=30
    local attempt=1

    while [ $attempt -le $max_attempts ]; do
        if pg_isready -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" > /dev/null 2>&1; then
            echo -e "${GREEN}PostgreSQL is ready!${NC}"
            return 0
        fi

        echo -e "  Attempt $attempt/$max_attempts - waiting..."
        sleep 2
        attempt=$((attempt + 1))
    done

    echo -e "${RED}Error: PostgreSQL is not available after $max_attempts attempts${NC}"
    exit 1
}

# Function to check if database exists, create if not
ensure_database() {
    echo -e "${YELLOW}Checking if database '$DB_NAME' exists...${NC}"

    # Use PGPASSWORD environment variable for password
    export PGPASSWORD="${DATABASE_PASSWORD:-postgres}"

    if psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -lqt 2>/dev/null | cut -d \| -f 1 | grep -qw "$DB_NAME"; then
        echo -e "${GREEN}Database '$DB_NAME' exists.${NC}"
    else
        echo -e "${YELLOW}Creating database '$DB_NAME'...${NC}"
        psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -c "CREATE DATABASE $DB_NAME;" 2>/dev/null || true
        echo -e "${GREEN}Database created.${NC}"
    fi

    # Enable required extensions
    echo -e "${YELLOW}Enabling required PostgreSQL extensions...${NC}"
    psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\";" 2>/dev/null || true
    psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "CREATE EXTENSION IF NOT EXISTS \"vector\";" 2>/dev/null || {
        echo -e "${YELLOW}Warning: pgvector extension not available. Vector similarity search will be disabled.${NC}"
    }

    unset PGPASSWORD
}

# Function to build the project
build_project() {
    echo -e "${YELLOW}Building backend project...${NC}"
    npm run build
    echo -e "${GREEN}Build completed.${NC}"
}

# Function to run migrations
run_migrations() {
    echo -e "${YELLOW}Running database migrations...${NC}"
    npm run migration:run
    echo -e "${GREEN}Migrations completed successfully!${NC}"
}

# Function to show migration status
show_migration_status() {
    echo -e "${YELLOW}Migration status:${NC}"
    npm run migration:show 2>/dev/null || echo -e "${YELLOW}Unable to show migration status${NC}"
}

# Function to run seed data
run_seeds() {
    echo -e "${YELLOW}Running seed data...${NC}"
    npm run seed 2>/dev/null || echo -e "${YELLOW}No seed data script found or seeds failed${NC}"
}

# Main execution
echo -e "${BLUE}Configuration:${NC}"
echo -e "  Host:     $DB_HOST"
echo -e "  Port:     $DB_PORT"
echo -e "  User:     $DB_USER"
echo -e "  Database: $DB_NAME"
echo ""

# Wait for PostgreSQL to be ready
wait_for_postgres

# Ensure database exists
ensure_database

# Build the project
build_project

# Run migrations
run_migrations

# Show migration status
echo ""
show_migration_status

# Check for --seed flag
if [[ "$1" == "--seed" ]]; then
    echo ""
    run_seeds
fi

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  Database setup completed!${NC}"
echo -e "${GREEN}========================================${NC}"
