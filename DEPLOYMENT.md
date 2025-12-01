# Deployment Guide

Complete guide for deploying MCP Everything to production environments.

## Table of Contents
- [Overview](#overview)
- [Environment Configuration](#environment-configuration)
- [Docker Deployment](#docker-deployment)
- [Database Setup](#database-setup)
- [Production Configuration](#production-configuration)
- [Monitoring and Logging](#monitoring-and-logging)
- [Scaling](#scaling)
- [Troubleshooting](#troubleshooting)

## Overview

MCP Everything supports multiple deployment strategies:

1. **Docker Compose** (Recommended for small-medium deployments)
2. **Kubernetes** (For enterprise/high-scale deployments)
3. **Cloud Platforms** (Vercel, Railway, Render, etc.)

### Deployment Architecture

```
┌─────────────────────────────────────────┐
│          Load Balancer / CDN            │
└─────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────┐
│          Frontend (Angular)             │
│  Static files served via CDN/Nginx      │
└─────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────┐
│          Backend (NestJS)               │
│  API Server + LangGraph Orchestration   │
└─────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────┐
│        PostgreSQL Database              │
│  Conversations + Checkpoints            │
└─────────────────────────────────────────┘
```

## Environment Configuration

### Production Environment Variables

Create a `.env.production` file:

```bash
#===========================================
# Environment
#===========================================
NODE_ENV=production

#===========================================
# Application
#===========================================
PORT=3000
FRONTEND_URL=https://your-domain.com
CORS_ORIGINS=https://your-domain.com

#===========================================
# API Keys (Required)
#===========================================
ANTHROPIC_API_KEY=sk-ant-xxx...
GITHUB_TOKEN=ghp_xxx...

#===========================================
# Database
#===========================================
DATABASE_HOST=your-database-host.com
DATABASE_PORT=5432
DATABASE_USER=postgres
DATABASE_PASSWORD=secure-password-here
DATABASE_NAME=mcp_everything
DATABASE_SSL=true

#===========================================
# Security
#===========================================
JWT_SECRET=generate-secure-32-character-secret-here
SESSION_SECRET=another-secure-secret-here

#===========================================
# Redis (Optional - for scaling)
#===========================================
REDIS_HOST=your-redis-host.com
REDIS_PORT=6379
REDIS_PASSWORD=redis-password-here

#===========================================
# Docker
#===========================================
DOCKER_HOST=unix:///var/run/docker.sock

#===========================================
# Monitoring (Optional)
#===========================================
SENTRY_DSN=https://xxx@sentry.io/xxx
LOG_LEVEL=info

#===========================================
# Performance
#===========================================
CACHE_ENABLED=true
MAX_PARALLEL_OPERATIONS=8
ANTHROPIC_REQUESTS_PER_MINUTE=1000
ANTHROPIC_TOKENS_PER_MINUTE=160000
```

### Secrets Management

**Never commit secrets to version control.**

Use a secrets management solution:

#### Using Docker Secrets

```bash
# Create secrets
echo "sk-ant-xxx..." | docker secret create anthropic_api_key -
echo "ghp_xxx..." | docker secret create github_token -

# Reference in docker-compose.yml
services:
  backend:
    secrets:
      - anthropic_api_key
      - github_token

secrets:
  anthropic_api_key:
    external: true
  github_token:
    external: true
```

#### Using Environment-Specific Files

```bash
# Production secrets (git-ignored)
.env.production.local

# Staging secrets (git-ignored)
.env.staging.local

# Load appropriate env file
NODE_ENV=production node dist/main.js
```

## Docker Deployment

### Docker Compose (Recommended)

#### Production docker-compose.yml

```yaml
version: '3.8'

services:
  # PostgreSQL Database
  database:
    image: postgres:16-alpine
    container_name: mcp-database
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${DATABASE_USER}
      POSTGRES_PASSWORD: ${DATABASE_PASSWORD}
      POSTGRES_DB: ${DATABASE_NAME}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    networks:
      - mcp-network
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${DATABASE_USER}"]
      interval: 10s
      timeout: 5s
      retries: 5

  # Backend API
  backend:
    build:
      context: .
      dockerfile: packages/backend/Dockerfile
      target: production
    container_name: mcp-backend
    restart: unless-stopped
    env_file:
      - .env.production
    ports:
      - "3000:3000"
    depends_on:
      database:
        condition: service_healthy
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - generated_servers:/app/generated-servers
    networks:
      - mcp-network
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/api/chat/health"]
      interval: 30s
      timeout: 10s
      retries: 3

  # Frontend
  frontend:
    build:
      context: .
      dockerfile: packages/frontend/Dockerfile
      target: production
    container_name: mcp-frontend
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    depends_on:
      - backend
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro
      - ./nginx/ssl:/etc/nginx/ssl:ro
    networks:
      - mcp-network

  # Redis (Optional - for scaling)
  redis:
    image: redis:7-alpine
    container_name: mcp-redis
    restart: unless-stopped
    command: redis-server --requirepass ${REDIS_PASSWORD}
    volumes:
      - redis_data:/data
    networks:
      - mcp-network
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  postgres_data:
    driver: local
  redis_data:
    driver: local
  generated_servers:
    driver: local

networks:
  mcp-network:
    driver: bridge
```

#### Deploy with Docker Compose

```bash
# Build and start services
docker-compose -f docker-compose.yml up -d

# View logs
docker-compose logs -f

# Stop services
docker-compose down

# Restart specific service
docker-compose restart backend

# View service status
docker-compose ps
```

### Individual Docker Images

#### Backend Dockerfile

```dockerfile
# packages/backend/Dockerfile
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY packages/backend/package*.json ./packages/backend/
COPY packages/shared/package*.json ./packages/shared/

# Install dependencies
RUN npm ci --workspace=packages/backend --workspace=packages/shared

# Copy source
COPY packages/backend ./packages/backend
COPY packages/shared ./packages/shared

# Build
RUN npm run build --workspace=packages/backend --workspace=packages/shared

# Production image
FROM node:20-alpine AS production

WORKDIR /app

# Copy built files and dependencies
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/backend/dist ./dist
COPY --from=builder /app/packages/backend/package*.json ./

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/chat/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start application
CMD ["node", "dist/main.js"]
```

#### Frontend Dockerfile

```dockerfile
# packages/frontend/Dockerfile
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY packages/frontend/package*.json ./packages/frontend/

# Install dependencies
RUN npm ci --workspace=packages/frontend

# Copy source
COPY packages/frontend ./packages/frontend

# Build for production
RUN npm run build --workspace=packages/frontend

# Production image with Nginx
FROM nginx:alpine AS production

# Copy built files
COPY --from=builder /app/packages/frontend/dist/frontend/browser /usr/share/nginx/html

# Copy Nginx configuration
COPY nginx/nginx.conf /etc/nginx/nginx.conf

# Expose ports
EXPOSE 80 443

# Start Nginx
CMD ["nginx", "-g", "daemon off;"]
```

### Nginx Configuration

```nginx
# nginx/nginx.conf
events {
  worker_connections 1024;
}

http {
  include /etc/nginx/mime.types;
  default_type application/octet-stream;

  # Gzip compression
  gzip on;
  gzip_vary on;
  gzip_min_length 1024;
  gzip_types text/plain text/css text/xml text/javascript
             application/x-javascript application/xml+rss
             application/json application/javascript;

  # Upstream backend
  upstream backend {
    server backend:3000;
  }

  server {
    listen 80;
    server_name your-domain.com;

    # Redirect HTTP to HTTPS
    return 301 https://$server_name$request_uri;
  }

  server {
    listen 443 ssl http2;
    server_name your-domain.com;

    # SSL configuration
    ssl_certificate /etc/nginx/ssl/cert.pem;
    ssl_certificate_key /etc/nginx/ssl/key.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    # Frontend (Angular)
    location / {
      root /usr/share/nginx/html;
      try_files $uri $uri/ /index.html;

      # Security headers
      add_header X-Frame-Options "SAMEORIGIN" always;
      add_header X-Content-Type-Options "nosniff" always;
      add_header X-XSS-Protection "1; mode=block" always;
    }

    # Backend API
    location /api/ {
      proxy_pass http://backend;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection 'upgrade';
      proxy_set_header Host $host;
      proxy_set_header X-Real-IP $remote_addr;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_cache_bypass $http_upgrade;

      # Timeouts for long-running requests
      proxy_connect_timeout 60s;
      proxy_send_timeout 300s;
      proxy_read_timeout 300s;
    }

    # SSE endpoint (special handling)
    location /api/chat/stream/ {
      proxy_pass http://backend;
      proxy_http_version 1.1;
      proxy_set_header Connection '';
      proxy_set_header Cache-Control 'no-cache';
      proxy_set_header X-Accel-Buffering 'no';
      proxy_buffering off;
      chunked_transfer_encoding off;
    }
  }
}
```

## Database Setup

### Production PostgreSQL

#### Using Managed Database (Recommended)

**Providers**:
- **AWS RDS**: Managed PostgreSQL with automatic backups
- **Google Cloud SQL**: Fully managed PostgreSQL
- **Digital Ocean**: Managed PostgreSQL databases
- **Supabase**: PostgreSQL with built-in backups

**Configuration**:
```bash
DATABASE_HOST=your-db.region.rds.amazonaws.com
DATABASE_PORT=5432
DATABASE_USER=postgres
DATABASE_PASSWORD=secure-password
DATABASE_NAME=mcp_everything
DATABASE_SSL=true
```

#### Self-Hosted PostgreSQL

```bash
# Install PostgreSQL
sudo apt-get update
sudo apt-get install postgresql-16

# Create database and user
sudo -u postgres psql
CREATE DATABASE mcp_everything;
CREATE USER mcp_user WITH ENCRYPTED PASSWORD 'secure-password';
GRANT ALL PRIVILEGES ON DATABASE mcp_everything TO mcp_user;
\q

# Configure for remote access
sudo nano /etc/postgresql/16/main/postgresql.conf
# Set: listen_addresses = '*'

sudo nano /etc/postgresql/16/main/pg_hba.conf
# Add: host all all 0.0.0.0/0 md5

# Restart PostgreSQL
sudo systemctl restart postgresql
```

### Database Migrations

```bash
# Run migrations in production
NODE_ENV=production npm run migration:run

# Create backup before migrations
pg_dump -U postgres mcp_everything > backup_$(date +%Y%m%d).sql

# Restore from backup if needed
psql -U postgres mcp_everything < backup_20251008.sql
```

### Database Backup Strategy

```bash
#!/bin/bash
# scripts/backup-database.sh

# Backup database
pg_dump -h $DATABASE_HOST -U $DATABASE_USER $DATABASE_NAME | gzip > \
  /backups/mcp_everything_$(date +%Y%m%d_%H%M%S).sql.gz

# Keep only last 30 days of backups
find /backups -name "mcp_everything_*.sql.gz" -mtime +30 -delete

# Upload to S3 (optional)
aws s3 cp /backups/mcp_everything_*.sql.gz s3://your-bucket/database-backups/
```

**Cron Job**:
```cron
# Daily backup at 2 AM
0 2 * * * /path/to/backup-database.sh
```

## Production Configuration

### Performance Tuning

#### Backend Optimization

```typescript
// packages/backend/src/main.ts
async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Enable compression
  app.use(compression());

  // CORS configuration
  app.enableCors({
    origin: process.env.FRONTEND_URL,
    credentials: true,
  });

  // Request timeout
  app.use((req, res, next) => {
    req.setTimeout(300000); // 5 minutes
    next();
  });

  // Graceful shutdown
  app.enableShutdownHooks();

  await app.listen(3000, '0.0.0.0');
}
```

#### Database Connection Pooling

```typescript
// packages/backend/src/database/database.config.ts
export const databaseConfig: TypeOrmModuleOptions = {
  type: 'postgres',
  host: process.env.DATABASE_HOST,
  port: parseInt(process.env.DATABASE_PORT),
  username: process.env.DATABASE_USER,
  password: process.env.DATABASE_PASSWORD,
  database: process.env.DATABASE_NAME,
  ssl: process.env.DATABASE_SSL === 'true',
  extra: {
    max: 20,              // Maximum pool size
    min: 5,               // Minimum pool size
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  },
  synchronize: false,      // Never auto-sync in production
  migrations: ['dist/migrations/*.js'],
  logging: process.env.LOG_LEVEL === 'debug',
};
```

### Security Hardening

```typescript
// Enable helmet for security headers
import helmet from 'helmet';
app.use(helmet());

// Rate limiting
import rateLimit from 'express-rate-limit';
app.use(rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
}));

// CSRF protection
import csurf from 'csurf';
app.use(csurf());
```

## Monitoring and Logging

### Application Logging

```typescript
// packages/backend/src/main.ts
import { WinstonModule } from 'nest-winston';
import * as winston from 'winston';

const app = await NestFactory.create(AppModule, {
  logger: WinstonModule.createLogger({
    transports: [
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.json()
        ),
      }),
      new winston.transports.File({
        filename: 'logs/error.log',
        level: 'error',
      }),
      new winston.transports.File({
        filename: 'logs/combined.log',
      }),
    ],
  }),
});
```

### Health Checks

```typescript
// packages/backend/src/chat/chat.controller.ts
@Get('health')
async healthCheck() {
  return {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    database: await this.checkDatabase(),
    ai: await this.checkAnthropicAPI(),
  };
}
```

### Error Tracking (Sentry)

```typescript
// packages/backend/src/main.ts
import * as Sentry from '@sentry/node';

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV,
    tracesSampleRate: 1.0,
  });
}
```

## Scaling

### Horizontal Scaling

```yaml
# docker-compose.scale.yml
services:
  backend:
    deploy:
      replicas: 3
      restart_policy:
        condition: on-failure
      resources:
        limits:
          cpus: '2'
          memory: 4G
        reservations:
          cpus: '1'
          memory: 2G

  # Load balancer
  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf
    depends_on:
      - backend
```

### Redis for Session Storage

```typescript
// packages/backend/src/cache/redis.config.ts
import { CacheModule } from '@nestjs/cache-manager';
import * as redisStore from 'cache-manager-redis-store';

@Module({
  imports: [
    CacheModule.register({
      store: redisStore,
      host: process.env.REDIS_HOST,
      port: process.env.REDIS_PORT,
      password: process.env.REDIS_PASSWORD,
      ttl: 86400, // 24 hours
    }),
  ],
})
export class AppModule {}
```

## Troubleshooting

### Common Production Issues

#### High Memory Usage

```bash
# Monitor memory
docker stats mcp-backend

# Analyze Node.js heap
node --inspect dist/main.js
# Connect Chrome DevTools to inspect:memory

# Increase Node.js heap limit
NODE_OPTIONS="--max-old-space-size=4096" node dist/main.js
```

#### Database Connection Timeout

```bash
# Check database connectivity
pg_isready -h $DATABASE_HOST -U $DATABASE_USER

# Test connection
psql -h $DATABASE_HOST -U $DATABASE_USER -d $DATABASE_NAME

# Check active connections
SELECT count(*) FROM pg_stat_activity;

# Kill idle connections
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
WHERE state = 'idle' AND state_change < now() - interval '10 minutes';
```

#### SSE Streaming Issues

```bash
# Check Nginx buffering
# In nginx.conf, ensure:
proxy_buffering off;
proxy_cache off;
chunked_transfer_encoding off;

# Test SSE endpoint directly
curl -N http://localhost:3000/api/chat/stream/test-session
```

### Deployment Checklist

- [ ] Environment variables configured
- [ ] Secrets properly managed
- [ ] Database migrations run
- [ ] SSL certificates installed
- [ ] Nginx configuration tested
- [ ] Health checks passing
- [ ] Logging configured
- [ ] Error tracking enabled
- [ ] Backups scheduled
- [ ] Monitoring alerts set up
- [ ] Load testing performed
- [ ] Security audit completed

## Support

For deployment issues:
1. Check application logs: `docker-compose logs -f backend`
2. Review health endpoint: `curl http://localhost:3000/api/chat/health`
3. Verify environment configuration
4. Contact support with error logs and environment details
