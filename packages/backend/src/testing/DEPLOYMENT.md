# Testing Service Deployment Checklist

## Pre-Deployment Verification

### Infrastructure Requirements

- [ ] Docker installed: `docker --version`
- [ ] Docker daemon running: `docker ps`
- [ ] Docker accessible to Node.js process
- [ ] Sufficient disk space: 500MB+ available in /tmp
- [ ] Sufficient memory: 1GB+ available on host
- [ ] Sufficient CPU: At least 1 core available

### Verify Installation

```bash
# Check Docker
docker --version
docker run --rm hello-world

# Check permissions (Node.js process can run Docker)
docker ps  # Should not require sudo

# Check disk space
df -h /tmp  # Need ~500MB free

# Check Node.js version
node --version  # Should be 20.x or later
```

## Environment Configuration

### Required Environment Variables

```bash
# Add to .env or Docker compose
# None required - service is standalone
```

### Optional Configuration

```bash
# Override default test timeouts (in docker-compose.yml or app config)
MCP_TEST_BUILD_TIMEOUT=300        # seconds (default: 120)
MCP_TEST_TOOL_TIMEOUT=10          # seconds (default: 5)
MCP_TEST_CPU_LIMIT=1              # cores (default: 0.5)
MCP_TEST_MEMORY_LIMIT=1024m       # bytes (default: 512m)
MCP_TEST_CLEANUP_ENABLED=true     # boolean (default: true)
```

## NestJS Module Integration

### Step 1: Add TestingModule to App

```typescript
// packages/backend/src/app.module.ts
import { Module } from '@nestjs/common';
import { TestingModule } from './testing/testing.module';
import { ChatModule } from './chat/chat.module';
import { OrchestrationModule } from './orchestration/orchestration.module';

@Module({
  imports: [
    // Existing modules
    ChatModule,
    OrchestrationModule,

    // New testing module
    TestingModule,
  ],
})
export class AppModule {}
```

### Step 2: Verify Module Registration

```bash
# Run the application
npm run start:dev

# Check logs for module loading
# Should see: "[NestFactory] Starting Nest application..."
# No errors about TestingModule
```

## Docker Dependency Verification

### Local Development

```bash
# Test Docker image building locally
docker build -f Dockerfile.test -t test-mcp-build .

# Test container with constraints
docker run --rm \
  --cpus="0.5" \
  --memory="512m" \
  --memory-swap="512m" \
  --network=none \
  test-mcp-build

# Verify no orphaned containers
docker ps -a  # Should be empty
docker images grep mcp  # Should be minimal
```

### CI/CD (GitHub Actions)

```yaml
# .github/workflows/deploy.yml
name: Deploy Testing Service

on:
  push:
    branches: [ main ]

jobs:
  test-service:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '20'

      - name: Install dependencies
        run: npm install

      - name: Build backend
        run: npm run build:backend

      - name: Test MCP testing service
        run: npm run test:testing

      - name: Verify Docker access
        run: docker ps
```

## Testing Service Verification

### Unit Tests

```bash
# Run testing service tests
npm run test -- testing.service.spec.ts

# Expected output:
# ✓ Should test valid MCP server
# ✓ Should handle build errors
# ✓ Should stream progress updates
# ✓ Should cleanup Docker resources
# ✓ Should validate MCP responses
```

### Integration Tests with Real Docker

```bash
# Run integration tests
npm run test:integration -- testing.controller.spec.ts

# This will:
# 1. Create Docker image
# 2. Run container with constraints
# 3. Test MCP protocol
# 4. Verify cleanup
# 5. Check resource limits
```

### Manual Testing

```bash
# Start the application
npm run start:dev

# Test via HTTP (in another terminal)
curl -X POST http://localhost:3000/api/testing/server \
  -H "Content-Type: application/json" \
  -d @test-payload.json

# Test via SSE
curl http://localhost:3000/api/testing/stream/test-session-123

# Verify cleanup
docker ps -a  # Should show no mcp-test containers
docker images | grep mcp-test  # Should be minimal
```

## Production Deployment

### Docker Compose Setup

```yaml
# docker-compose.yml
version: '3.8'

services:
  mcp-backend:
    build:
      context: ./packages/backend
      dockerfile: Dockerfile
    ports:
      - "3000:3000"
    environment:
      NODE_ENV: production
      # Testing service config (optional)
      MCP_TEST_BUILD_TIMEOUT: 300
      MCP_TEST_TOOL_TIMEOUT: 10
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock  # Docker access
      - /tmp:/tmp  # Temp directory for tests
    privileged: false
    cap_drop:
      - ALL
    cap_add:
      - NET_BIND_SERVICE
    security_opt:
      - no-new-privileges:true

  # PostgreSQL for state management
  postgres:
    image: postgres:15-alpine
    environment:
      POSTGRES_PASSWORD: secure-password
    volumes:
      - postgres_data:/var/lib/postgresql/data

volumes:
  postgres_data:
```

### Kubernetes Deployment

```yaml
# k8s/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mcp-backend
spec:
  replicas: 2
  selector:
    matchLabels:
      app: mcp-backend
  template:
    metadata:
      labels:
        app: mcp-backend
    spec:
      containers:
      - name: backend
        image: mcp-backend:latest
        ports:
        - containerPort: 3000
        resources:
          requests:
            memory: "512Mi"
            cpu: "500m"
          limits:
            memory: "1Gi"
            cpu: "1000m"
        volumeMounts:
        - name: docker-socket
          mountPath: /var/run/docker.sock
        - name: temp
          mountPath: /tmp
        env:
        - name: NODE_ENV
          value: production
        livenessProbe:
          httpGet:
            path: /api/testing/health
            port: 3000
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /api/testing/health
            port: 3000
          initialDelaySeconds: 5
          periodSeconds: 5

      volumes:
      - name: docker-socket
        hostPath:
          path: /var/run/docker.sock
      - name: temp
        emptyDir: {}
```

### Kubernetes ConfigMap for Testing

```yaml
# k8s/configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: mcp-testing-config
data:
  # Testing service configuration
  MCP_TEST_BUILD_TIMEOUT: "300"
  MCP_TEST_TOOL_TIMEOUT: "10"
  MCP_TEST_CPU_LIMIT: "0.5"
  MCP_TEST_MEMORY_LIMIT: "512m"
  MCP_TEST_NETWORK_MODE: "none"
  MCP_TEST_CLEANUP_ENABLED: "true"
```

## Monitoring & Observability

### Health Check Endpoint

```bash
# Verify testing service health
curl http://localhost:3000/api/testing/health

# Expected response:
# {
#   "status": "healthy",
#   "docker": true
# }
```

### Logging Configuration

```typescript
// logger.config.ts
export const loggingConfig = {
  testing: {
    level: 'log',           // All logs
    context: 'TestingService',

    // Log levels per operation
    operations: {
      buildDocker: 'debug',
      runContainer: 'debug',
      testTool: 'log',
      cleanup: 'warn',      // Only warn/error
    }
  }
};
```

### Monitoring Queries

```typescript
// Monitor via observability platform
// Prometheus query examples:

// Test success rate (last 5 minutes)
rate(mcp_tests_passed[5m]) / rate(mcp_tests_total[5m])

// Build time (p95)
histogram_quantile(0.95, mcp_build_duration_seconds)

// Tool test execution time
histogram_quantile(0.50, mcp_tool_test_duration_seconds)

// Docker resource cleanup failures
increase(mcp_cleanup_errors_total[5m])

// Active containers (should be 0)
mcp_active_containers_count
```

### Alert Rules

```yaml
# prometheus-rules.yaml
groups:
- name: mcp-testing
  rules:
  - alert: TestingServiceDown
    expr: up{job="mcp-backend"} == 0
    for: 2m
    annotations:
      summary: "MCP testing service is down"

  - alert: HighTestFailureRate
    expr: rate(mcp_tests_failed[5m]) > 0.2
    for: 5m
    annotations:
      summary: "20%+ test failure rate detected"

  - alert: BuildTimeoutIncreasing
    expr: histogram_quantile(0.95, mcp_build_duration_seconds) > 180
    for: 10m
    annotations:
      summary: "Build times exceeding 3 minutes"

  - alert: CleanupFailures
    expr: rate(mcp_cleanup_errors_total[5m]) > 0
    for: 2m
    annotations:
      summary: "Docker cleanup failures detected"
```

## Security Hardening

### Pre-Deployment Security Checklist

- [ ] Docker daemon runs with secure socket
- [ ] Node.js process has minimal Docker permissions
- [ ] /tmp directory has appropriate permissions
- [ ] Temp files are cleaned up after tests
- [ ] No sensitive data logged (API keys, credentials)
- [ ] Container security options are enforced
- [ ] Cleanup errors are logged (for investigation)

### Container Security Settings

```bash
# Verify container security
docker run \
  --cap-drop=ALL \
  --read-only \
  --security-opt=no-new-privileges \
  --cpus="0.5" \
  --memory="512m" \
  --network=none \
  --pids-limit=64 \
  --ulimit nofile=1024 \
  mcp-test-server:latest
```

### Network Security

- [ ] Testing service runs with `--network=none`
- [ ] No outbound connectivity from tested containers
- [ ] Testing service uses private Docker socket
- [ ] No ports exposed from test containers

## Performance Tuning

### Recommended Settings

```typescript
// For high-throughput environments
const config: McpTestConfig = {
  cpuLimit: '0.5',        // Don't exceed 50% (shared resource)
  memoryLimit: '512m',    // Sufficient for most MCP servers
  timeout: 120,           // 2 minutes for full test
  toolTimeout: 5,         // 5 seconds per tool
  cleanup: true,          // Always clean up
};
```

### Resource Provisioning

**Minimum**:
- CPU: 2 cores
- RAM: 2GB
- Disk: 5GB
- Network: 100Mbps

**Recommended**:
- CPU: 4 cores
- RAM: 8GB
- Disk: 20GB
- Network: 1Gbps

**High-Throughput**:
- CPU: 8+ cores
- RAM: 16GB+
- Disk: 50GB+
- Network: 10Gbps

## Rollback Procedure

If issues occur post-deployment:

```bash
# 1. Stop new version
docker-compose down

# 2. Verify no orphaned resources
docker ps -a  # Should be empty
docker images | grep mcp  # Should be empty

# 3. Restore previous version
docker-compose up -d

# 4. Verify health
curl http://localhost:3000/api/testing/health

# 5. Check logs for issues
docker-compose logs -f backend
```

## Maintenance

### Regular Tasks

- [ ] Monitor Docker disk usage: `docker system df`
- [ ] Clean up dangling images: `docker image prune`
- [ ] Review cleanup error logs weekly
- [ ] Update Docker version monthly
- [ ] Review test success rates in metrics

### Monthly Maintenance

```bash
# Clean up Docker resources
docker system prune -a --volumes

# Verify disk space
du -sh /tmp/mcp-testing
du -sh /var/lib/docker

# Check Docker logs for errors
docker logs mcp-backend | grep -i error
```

### Quarterly Reviews

- Update base Node.js image
- Review MCP SDK version
- Analyze test performance trends
- Update documentation

## Troubleshooting Guide

### Issue: "Docker daemon not accessible"

```bash
# Check Docker socket
ls -la /var/run/docker.sock

# Add Node.js process to docker group
sudo usermod -aG docker nodejs

# Restart service
npm run start:dev
```

### Issue: "Permission denied" on /tmp

```bash
# Fix /tmp permissions
sudo chmod 1777 /tmp

# Or use alternate temp directory
export TMPDIR=/var/tmp
npm run start:dev
```

### Issue: Build timeout

```bash
# Increase timeout
# In docker-compose.yml or app config:
MCP_TEST_BUILD_TIMEOUT=300

# Or increase in config
await testingService.testMcpServer(code, {
  timeout: 300  // 5 minutes
});
```

### Issue: Orphaned containers after crash

```bash
# Clean up all mcp-test containers
docker ps -a | grep mcp-test | awk '{print $1}' | xargs docker rm

# Remove all mcp-test images
docker images | grep mcp-test | awk '{print $3}' | xargs docker rmi

# Clean up temp files
rm -rf /tmp/mcp-testing/*
```

## Sign-Off

- [ ] Infrastructure requirements verified
- [ ] Docker access confirmed
- [ ] NestJS module integrated
- [ ] Unit tests passing
- [ ] Integration tests passing
- [ ] Manual testing successful
- [ ] Production configuration deployed
- [ ] Monitoring and alerts configured
- [ ] Security hardening verified
- [ ] Documentation reviewed

**Ready for Production**: Yes / No

**Deployment Date**: ________________

**Deployed By**: ________________

**Verified By**: ________________

---

**Note**: Always test in staging environment before production deployment.
