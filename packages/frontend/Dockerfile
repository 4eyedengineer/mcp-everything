# Multi-stage build for Angular frontend
FROM node:18-alpine AS base

# Install system dependencies
RUN apk add --no-cache python3 make g++

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY packages/frontend/package*.json ./packages/frontend/
COPY packages/shared/package*.json ./packages/shared/

# Install dependencies
RUN npm ci && npm cache clean --force

# Development stage
FROM base AS development
COPY . .
EXPOSE 4200
CMD ["npm", "run", "start", "--workspace=@mcp-everything/frontend"]

# Build stage
FROM base AS build
COPY . .

# Build shared package first
RUN npm run build --workspace=@mcp-everything/shared

# Build frontend for production
RUN npm run build:prod --workspace=@mcp-everything/frontend

# Production stage with nginx
FROM nginx:alpine AS production

# Install curl for health checks
RUN apk add --no-cache curl

# Copy nginx configuration
COPY packages/frontend/nginx.conf /etc/nginx/nginx.conf

# Copy built application
COPY --from=build /app/packages/frontend/dist/mcp-everything-frontend /usr/share/nginx/html

# Create nginx user and set permissions
RUN chown -R nginx:nginx /usr/share/nginx/html
RUN chown -R nginx:nginx /var/cache/nginx

# Create nginx log directory
RUN mkdir -p /var/log/nginx && chown -R nginx:nginx /var/log/nginx

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:80 || exit 1

# Expose port
EXPOSE 80

# Switch to non-root user
USER nginx

# Start nginx
CMD ["nginx", "-g", "daemon off;"]