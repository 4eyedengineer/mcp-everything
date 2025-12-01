# Base Docker image for generated MCP servers
# This provides a common foundation with MCP dependencies pre-installed
FROM node:18-alpine AS base

# Install system dependencies
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    curl \
    git

# Create app directory
WORKDIR /app

# Create non-root user for security
RUN addgroup -g 1001 -S mcpuser
RUN adduser -S mcpuser -u 1001

# Install common MCP dependencies globally for faster builds
RUN npm install -g \
    typescript \
    @modelcontextprotocol/sdk \
    dotenv \
    @types/node

# Create logs directory
RUN mkdir -p /app/logs && chown mcpuser:mcpuser /app/logs

# Development stage
FROM base AS development
USER mcpuser
EXPOSE 3000
CMD ["npm", "run", "start:dev"]

# Production stage
FROM base AS production

# Copy package files (will be overridden by generated servers)
COPY package*.json ./

# Install production dependencies
RUN npm ci --only=production && npm cache clean --force

# Copy application code (will be overridden by generated servers)
COPY . .

# Change ownership to non-root user
RUN chown -R mcpuser:mcpuser /app

# Switch to non-root user
USER mcpuser

# Health check (generic - can be overridden)
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Expose port
EXPOSE 3000

# Default command (will be overridden by generated servers)
CMD ["npm", "start"]