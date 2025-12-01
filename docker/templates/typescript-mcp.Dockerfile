# Multi-stage TypeScript MCP Server Dockerfile Template
# This template is designed for fast builds with aggressive layer caching
ARG BASE_IMAGE=mcp-everything/node-alpine:latest
FROM ${BASE_IMAGE} AS base

# Build stage - compile TypeScript
FROM base AS build

# Copy package files first for better caching
COPY package*.json ./
COPY tsconfig.json ./

# Install all dependencies (including dev dependencies for build)
RUN npm ci --silent && npm cache clean --force

# Copy source code
COPY src/ ./src/

# Build the application
RUN npm run build && \
    npm prune --production --silent && \
    npm cache clean --force

# Production stage - minimal runtime
FROM base AS production

# Copy package.json for runtime dependencies
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production --silent && npm cache clean --force

# Copy built application from build stage
COPY --from=build --chown=mcpuser:mcpuser /app/dist ./dist

# Copy any additional files needed at runtime
COPY --chown=mcpuser:mcpuser README.md ./
COPY --chown=mcpuser:mcpuser .env.example ./

# Create MCP manifest endpoint
RUN echo '{"name":"{{SERVER_NAME}}","version":"{{VERSION}}","mcpVersion":"{{MCP_VERSION}}","description":"{{DESCRIPTION}}"}' > manifest.json

# Final configuration
USER mcpuser
EXPOSE 3000

# Health check for MCP server
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:3000/health || curl -f http://localhost:3000/.well-known/mcp || exit 1

# Start the MCP server
CMD ["node", "dist/index.js"]