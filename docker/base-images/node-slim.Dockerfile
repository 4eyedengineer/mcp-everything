# Lightweight Node.js base for simple MCP servers
# Build: docker build -f docker/base-images/node-slim.Dockerfile -t mcp-everything/node-slim:latest .
FROM node:18-slim AS base

# Install minimal system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    dumb-init \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Create non-root user
RUN groupadd --gid 1001 mcpuser && \
    useradd --uid 1001 --gid mcpuser --shell /bin/bash --create-home mcpuser

# Install core MCP dependencies
RUN npm install -g --silent \
    @modelcontextprotocol/sdk@^1.0.0 \
    typescript@5.2.2 \
    dotenv@16.3.1 && \
    npm cache clean --force

# Create directories
RUN mkdir -p /app/logs /app/src /app/dist && \
    chown -R mcpuser:mcpuser /app

ENV NODE_ENV=production
USER mcpuser
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]