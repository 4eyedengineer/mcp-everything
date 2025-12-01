# Python MCP Server Dockerfile Template
ARG BASE_IMAGE=mcp-everything/python-alpine:latest
FROM ${BASE_IMAGE}

# Copy requirements first for better caching
COPY requirements.txt ./

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

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

CMD ["python", "src/main.py"]