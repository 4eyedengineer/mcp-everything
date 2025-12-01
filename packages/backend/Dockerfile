# Multi-stage build for production optimization
FROM node:18-alpine AS base

# Install system dependencies
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    docker-cli \
    curl

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY packages/backend/package*.json ./packages/backend/
COPY packages/shared/package*.json ./packages/shared/

# Install dependencies
RUN npm ci --only=production && npm cache clean --force

# Development stage
FROM base AS development
RUN npm ci
COPY . .
EXPOSE 3000
CMD ["npm", "run", "start:dev", "--workspace=@mcp-everything/backend"]

# Build stage
FROM base AS build
RUN npm ci
COPY . .
RUN npm run build --workspace=@mcp-everything/shared
RUN npm run build --workspace=@mcp-everything/backend

# Production stage
FROM node:18-alpine AS production

# Install system dependencies for runtime
RUN apk add --no-cache \
    docker-cli \
    curl \
    dumb-init

# Create app user
RUN addgroup -g 1001 -S nodejs
RUN adduser -S nestjs -u 1001

# Set working directory
WORKDIR /app

# Copy package files and install production dependencies
COPY package*.json ./
COPY packages/backend/package*.json ./packages/backend/
COPY packages/shared/package*.json ./packages/shared/
RUN npm ci --only=production && npm cache clean --force

# Copy built application
COPY --from=build --chown=nestjs:nodejs /app/packages/backend/dist ./packages/backend/dist
COPY --from=build --chown=nestjs:nodejs /app/packages/shared/dist ./packages/shared/dist

# Create directories for generated servers
RUN mkdir -p /app/generated-servers && chown nestjs:nodejs /app/generated-servers
RUN mkdir -p /app/logs && chown nestjs:nodejs /app/logs

# Switch to non-root user
USER nestjs

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/api/v1/health || exit 1

# Expose port
EXPOSE 3000

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "packages/backend/dist/main.js"]