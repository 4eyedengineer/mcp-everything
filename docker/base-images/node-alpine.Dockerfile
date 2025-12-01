# Optimized Node.js Alpine base for MCP servers
# Build: docker build -f docker/base-images/node-alpine.Dockerfile -t mcp-everything/node-alpine:latest .
FROM node:18-alpine AS base

# Install system dependencies in a single layer
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    curl \
    git \
    dumb-init

# Set up working directory
WORKDIR /app

# Create non-root user
RUN addgroup -g 1001 -S mcpuser && \
    adduser -S mcpuser -u 1001 -G mcpuser

# Install common MCP dependencies globally for layer caching
RUN npm install -g --silent \
    typescript@5.2.2 \
    @types/node@20.8.0 \
    dotenv@16.3.1 && \
    npm cache clean --force

# Pre-install most common MCP server dependencies for better caching
COPY docker/base-images/common-deps.package.json /tmp/package.json
RUN cd /tmp && \
    npm install --silent && \
    npm cache clean --force && \
    mkdir -p /app/node_modules && \
    cp -R /tmp/node_modules/* /app/node_modules/ || true

# Create necessary directories
RUN mkdir -p /app/logs /app/src /app/dist && \
    chown -R mcpuser:mcpuser /app

# Set up environment
ENV NODE_ENV=production
ENV PATH="/app/node_modules/.bin:$PATH"

# Health check command
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

USER mcpuser
EXPOSE 3000

# Default command (to be overridden)
CMD ["node", "dist/index.js"]