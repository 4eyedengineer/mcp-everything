# JavaScript MCP Server Dockerfile Template
# Optimized for JavaScript-only MCP servers (no compilation needed)
ARG BASE_IMAGE=mcp-everything/node-slim:latest
FROM ${BASE_IMAGE}

# Copy package files first for optimal caching
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production --silent && npm cache clean --force

# Copy application source
COPY --chown=mcpuser:mcpuser src/ ./src/
COPY --chown=mcpuser:mcpuser README.md ./

# Create MCP manifest
RUN echo '{"name":"{{SERVER_NAME}}","version":"{{VERSION}}","mcpVersion":"{{MCP_VERSION}}","description":"{{DESCRIPTION}}"}' > manifest.json

USER mcpuser
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/health || curl -f http://localhost:3000/.well-known/mcp || exit 1

CMD ["node", "src/index.js"]