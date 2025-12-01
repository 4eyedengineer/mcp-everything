# API Proxy MCP Server Dockerfile Template
# Optimized for lightweight API proxy servers
FROM mcp-everything/node-slim:latest

# Copy package files first
COPY package*.json ./

# Install minimal dependencies for API proxies
RUN npm ci --only=production --silent && npm cache clean --force

# Copy application source
COPY --chown=mcpuser:mcpuser src/ ./src/
COPY --chown=mcpuser:mcpuser config/ ./config/
COPY --chown=mcpuser:mcpuser README.md ./

# Create MCP manifest with API proxy capabilities
RUN echo '{"name":"{{SERVER_NAME}}","version":"{{VERSION}}","mcpVersion":"{{MCP_VERSION}}","description":"{{DESCRIPTION}}","capabilities":["proxy","api"]}' > manifest.json

USER mcpuser
EXPOSE 3000

# Health check with API endpoint validation
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:3000/health && curl -f http://localhost:3000/api/status || exit 1

CMD ["node", "src/index.js"]