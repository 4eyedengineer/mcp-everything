# Python Alpine base for Python-based MCP servers
# Build: docker build -f docker/base-images/python-alpine.Dockerfile -t mcp-everything/python-alpine:latest .
FROM python:3.11-alpine AS base

# Install system dependencies
RUN apk add --no-cache \
    curl \
    git \
    build-base \
    libffi-dev \
    openssl-dev \
    dumb-init

WORKDIR /app

# Create non-root user
RUN addgroup -g 1001 -S mcpuser && \
    adduser -S mcpuser -u 1001 -G mcpuser

# Install common Python MCP dependencies
RUN pip install --no-cache-dir \
    mcp==1.0.0 \
    pydantic==2.4.0 \
    httpx==0.25.0 \
    click==8.1.7 \
    uvicorn==0.23.0 \
    fastapi==0.104.0

# Create directories
RUN mkdir -p /app/logs /app/src && \
    chown -R mcpuser:mcpuser /app

ENV PYTHONPATH=/app
ENV PYTHONUNBUFFERED=1
USER mcpuser
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

CMD ["python", "src/main.py"]