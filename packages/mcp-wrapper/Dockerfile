# MCP HTTP Wrapper Container Image
# This Dockerfile creates a universal HTTP wrapper for stdio-based MCP servers
# enabling Kubernetes deployment with health checks and load balancing.

# Stage 1: Build the wrapper
FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies
RUN apk add --no-cache python3 make g++

# Copy wrapper package files
COPY package*.json ./
RUN npm ci

# Copy wrapper source
COPY tsconfig.json ./
COPY src/ ./src/

# Build TypeScript
RUN npm run build

# Stage 2: Production image
FROM node:20-alpine AS production

WORKDIR /app

# Create non-root user for security
RUN addgroup -g 1001 mcp && \
    adduser -u 1001 -G mcp -S mcp

# Install production dependencies only
COPY package*.json ./
RUN npm ci --production && \
    npm cache clean --force

# Copy built wrapper
COPY --from=builder /app/dist ./dist

# Create directory for MCP server
RUN mkdir -p /app/server && chown -R mcp:mcp /app

# Environment variables with defaults
ENV NODE_ENV=production
ENV PORT=3000
ENV MCP_COMMAND="node"
ENV MCP_ARGS="server/dist/index.js"
ENV MCP_REQUEST_TIMEOUT=30000

# Switch to non-root user
USER mcp

# Expose the wrapper port
EXPOSE 3000

# Health check for Kubernetes
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Start the wrapper
CMD ["node", "dist/index.js"]

# Usage Notes:
# ------------
# This image is designed to be used as a base for MCP server containers.
# When building a complete MCP server container, you should:
#
# 1. Use this as a base image or multi-stage build source
# 2. Copy your generated MCP server code to /app/server/
# 3. Ensure the MCP server has been built (dist/ exists)
# 4. Set MCP_ARGS if your entry point differs from server/dist/index.js
#
# Example Dockerfile for a generated MCP server:
# ----------------------------------------------
# FROM ghcr.io/4eyedengineer/mcp-wrapper:latest
# COPY --chown=mcp:mcp ./generated-server/ ./server/
# ENV MCP_ARGS="server/dist/index.js"
