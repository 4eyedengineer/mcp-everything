# MCP Server Hosting Architecture

## Overview

This document describes the architecture for dynamically hosting generated MCP servers on a self-managed Kubernetes cluster.

## GitOps Repository

The GitOps manifests are managed in a dedicated repository:

**Repository**: [mcp-server-deployments](https://github.com/4eyedengineer/mcp-server-deployments)

This repository contains:
- **base/**: Kustomize base resources (namespace, quotas, limits, network policies)
- **argocd/**: ArgoCD ApplicationSet for dynamic server discovery
- **servers/**: Auto-generated per-server K8s manifests

See the [mcp-server-deployments README](https://github.com/4eyedengineer/mcp-server-deployments#readme) for setup instructions.

## High-Level Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              USER FLOW                                       │
└─────────────────────────────────────────────────────────────────────────────┘

User: "Create Stripe MCP server" → [Generate] → [Test] → [Host on Cloud]
                                                              │
                                                              ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           HOSTING PIPELINE                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. BUILD          2. PUSH           3. MANIFEST        4. GITOPS           │
│  ┌──────────┐     ┌──────────┐      ┌──────────┐       ┌──────────┐        │
│  │ Docker   │────►│ GitHub   │      │ Generate │──────►│ Commit   │        │
│  │ Build    │     │ Container│      │ K8s YAML │       │ to Repo  │        │
│  │          │     │ Registry │      │          │       │          │        │
│  └──────────┘     └──────────┘      └──────────┘       └──────────┘        │
│                                                              │              │
│                                                              ▼              │
│                                                        ┌──────────┐        │
│                                                        │ ArgoCD   │        │
│                                                        │ Sync     │        │
│                                                        └──────────┘        │
│                                                              │              │
└──────────────────────────────────────────────────────────────┼──────────────┘
                                                               │
                                                               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         KUBERNETES CLUSTER                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    mcp-servers namespace                             │    │
│  │                                                                      │    │
│  │   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                │    │
│  │   │ stripe-abc  │  │ github-def  │  │ custom-xyz  │   ...          │    │
│  │   │             │  │             │  │             │                │    │
│  │   │ Deployment  │  │ Deployment  │  │ Deployment  │                │    │
│  │   │ Service     │  │ Service     │  │ Service     │                │    │
│  │   │ Ingress     │  │ Ingress     │  │ Ingress     │                │    │
│  │   └─────────────┘  └─────────────┘  └─────────────┘                │    │
│  │                                                                      │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    Ingress Controller (nginx)                        │    │
│  │                                                                      │    │
│  │   *.mcp.yourdomain.com → Route to appropriate MCP server            │    │
│  │                                                                      │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
                                         │
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           CLIENT CONNECTION                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────┐     stdio      ┌─────────────────┐  MCP Streamable    │
│  │ Claude Desktop  │◄──────────────►│ mcp-connect     │◄──────HTTP─────────►│
│  │                 │                │ (local proxy)   │  (POST /mcp)        │
│  └─────────────────┘                └─────────────────┘                     │
│                                                              │              │
│                                            https://stripe-abc.mcp.domain.com│
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Component Details

### 1. Container Registry (GitHub Container Registry)

We use GHCR because:
- Already have GitHub integration
- Free for public images
- Authentication via existing GITHUB_TOKEN
- Clean integration with GitHub repos

Image naming convention:
```
ghcr.io/4eyedengineer/mcp-servers/{server-id}:latest
ghcr.io/4eyedengineer/mcp-servers/{server-id}:{version}
```

### 2. GitOps Repository Structure

Dedicated repository: `mcp-server-deployments`

```
mcp-server-deployments/
├── README.md
├── base/                          # Shared base resources
│   ├── namespace.yaml
│   ├── network-policy.yaml
│   └── resource-quota.yaml
├── servers/                       # Per-server manifests (auto-generated)
│   ├── stripe-abc123/
│   │   ├── deployment.yaml
│   │   ├── service.yaml
│   │   └── ingress.yaml
│   ├── github-def456/
│   │   ├── deployment.yaml
│   │   ├── service.yaml
│   │   └── ingress.yaml
│   └── ...
└── argocd/                        # ArgoCD configuration
    └── applicationset.yaml        # Auto-discovers servers/ subdirectories
```

### 3. ArgoCD ApplicationSet

Uses directory generator to auto-discover and deploy all servers:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: mcp-servers
  namespace: argocd
spec:
  generators:
    - git:
        repoURL: https://github.com/4eyedengineer/mcp-server-deployments.git
        revision: HEAD
        directories:
          - path: servers/*
  template:
    metadata:
      name: 'mcp-{{path.basename}}'
    spec:
      project: default
      source:
        repoURL: https://github.com/4eyedengineer/mcp-server-deployments.git
        targetRevision: HEAD
        path: '{{path}}'
      destination:
        server: https://kubernetes.default.svc
        namespace: mcp-servers
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
```

### 4. Per-Server Kubernetes Resources

Each MCP server gets three resources:

**Deployment** (`deployment.yaml`):
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mcp-{server-id}
  namespace: mcp-servers
  labels:
    app: mcp-server
    server-id: {server-id}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: mcp-server
      server-id: {server-id}
  template:
    metadata:
      labels:
        app: mcp-server
        server-id: {server-id}
    spec:
      containers:
        - name: mcp-server
          image: ghcr.io/4eyedengineer/mcp-servers/{server-id}:latest
          ports:
            - containerPort: 3000
          resources:
            requests:
              memory: "128Mi"
              cpu: "100m"
            limits:
              memory: "256Mi"
              cpu: "500m"
          env:
            - name: MCP_SERVER_ID
              value: "{server-id}"
          livenessProbe:
            httpGet:
              path: /health
              port: 3000
            initialDelaySeconds: 10
            periodSeconds: 30
          readinessProbe:
            httpGet:
              path: /health
              port: 3000
            initialDelaySeconds: 5
            periodSeconds: 10
```

**Service** (`service.yaml`):
```yaml
apiVersion: v1
kind: Service
metadata:
  name: mcp-{server-id}
  namespace: mcp-servers
spec:
  selector:
    app: mcp-server
    server-id: {server-id}
  ports:
    - port: 80
      targetPort: 3000
```

**Ingress** (`ingress.yaml`):
```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: mcp-{server-id}
  namespace: mcp-servers
  annotations:
    kubernetes.io/ingress.class: nginx
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  tls:
    - hosts:
        - {server-id}.mcp.yourdomain.com
      secretName: mcp-{server-id}-tls
  rules:
    - host: {server-id}.mcp.yourdomain.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: mcp-{server-id}
                port:
                  number: 80
```

### 5. Generated servers speak HTTP natively (no separate wrapper process)

There is no HTTP wrapper process. Generated MCP servers are dual-transport by
construction (codegen in `refinement.service.ts`, high-level `McpServer` +
`registerTool` API from `@modelcontextprotocol/sdk` `1.30.0`): they read
`MCP_TRANSPORT` from the environment and either start a `StdioServerTransport`
(default, unset or `stdio` - this is what Claude Desktop and the
GitHub/Gist download path use unchanged) or a per-session
`StreamableHTTPServerTransport` (`MCP_TRANSPORT=http`) that serves real MCP
Streamable HTTP on `POST /mcp` (`PORT`, default 3000) plus `GET /health` for
K8s probes. `ManifestGeneratorService` sets `MCP_TRANSPORT=http` on every
generated Deployment, which is what makes the liveness/readiness probes
below viable at all.

```
┌─────────────────────────────────────────────────────────────┐
│              MCP Server Container (MCP_TRANSPORT=http)       │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│   ┌──────────────────────────────────────────────────┐     │
│   │ MCP Server (Generated Code)                       │     │
│   │  McpServer + registerTool, one instance per        │     │
│   │  Mcp-Session-Id                                    │     │
│   │                                                    │     │
│   │  POST /mcp    (Streamable HTTP, SSE-framed)         │     │
│   │  GET  /health                                       │     │
│   └──────────────────────────────────────────────────┘     │
│          ▲                                                  │
│          │ port 3000 (PORT env)                              │
└──────────┼──────────────────────────────────────────────────┘
           │
    Kubernetes Service
```

The previous `packages/mcp-wrapper` package (an Express process that spawned
the stdio server as a child and bridged HTTP/WebSocket to its stdin/stdout)
has been **deleted**. It's obsolete now that generated servers open their own
HTTP listener directly - there's no stdio child process to bridge to in
`http` mode.

**Unverified**: there is no Docker daemon on the dev machine, so the
container path above (build → run with `MCP_TRANSPORT=http` → probes pass)
has not been exercised against a real container, and the K8s hosting path
as a whole has never been run end-to-end against a real cluster.

### 6. Local Proxy (`@mcpeverything/connect`)

```
npm install -g @mcpeverything/connect
```

Claude Desktop config:
```json
{
  "mcpServers": {
    "stripe": {
      "command": "mcp-connect",
      "args": ["stripe-abc123"]
    }
  }
}
```

**Intended contract** (the piece this proxy exists to provide): speak stdio
to Claude Desktop on one side, and real MCP Streamable HTTP
(`POST https://{server-id}.mcp.yourdomain.com/mcp`, `Accept` including
`text/event-stream`, `Mcp-Session-Id` echoed after `initialize`) to the
hosted server on the other - i.e. exactly the protocol generated servers
now actually speak in `http` mode.

`packages/mcp-connect` is currently being reworked to that contract; as of
this writing its `StdioTransport` class still speaks a bespoke JSON-RPC
protocol (`POST {serverUrl}/mcp` with a bearer token, falling back to a raw
WebSocket for streaming methods) rather than real Streamable HTTP framing.
Don't take the class name or current request/response shape in
`packages/mcp-connect/src/transport.ts` as the target design - it predates
this change and is mid-rewrite.

## Database Schema

```sql
CREATE TABLE hosted_servers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID REFERENCES conversations(id),
  user_id UUID,  -- For future auth

  -- Server info
  server_name VARCHAR(100) NOT NULL,
  server_id VARCHAR(50) UNIQUE NOT NULL,  -- e.g., "stripe-abc123"
  description TEXT,

  -- Container info
  docker_image VARCHAR(255) NOT NULL,
  image_tag VARCHAR(100) DEFAULT 'latest',

  -- K8s info
  k8s_namespace VARCHAR(100) DEFAULT 'mcp-servers',
  k8s_deployment_name VARCHAR(100),

  -- Endpoint
  endpoint_url TEXT NOT NULL,  -- https://{server-id}.mcp.domain.com

  -- Status
  status VARCHAR(20) DEFAULT 'pending',
  -- pending, building, pushing, deploying, running, stopped, failed, deleted
  status_message TEXT,

  -- Usage tracking
  request_count INTEGER DEFAULT 0,
  last_request_at TIMESTAMP,

  -- Lifecycle
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  stopped_at TIMESTAMP,
  deleted_at TIMESTAMP,

  -- Metadata
  tools JSONB,  -- List of tools this server provides
  env_vars JSONB  -- Required environment variables (names only, not values)
);

-- Index for lookups
CREATE INDEX idx_hosted_servers_server_id ON hosted_servers(server_id);
CREATE INDEX idx_hosted_servers_status ON hosted_servers(status);
CREATE INDEX idx_hosted_servers_user_id ON hosted_servers(user_id);
```

## API Endpoints

### Hosting Controller

```
POST   /api/hosting/deploy/:conversationId   - Deploy server to K8s
GET    /api/hosting/servers                  - List user's hosted servers
GET    /api/hosting/servers/:serverId        - Get server details
GET    /api/hosting/servers/:serverId/status - Get deployment status
GET    /api/hosting/servers/:serverId/logs   - Get server logs
POST   /api/hosting/servers/:serverId/stop   - Stop (scale to 0)
POST   /api/hosting/servers/:serverId/start  - Start (scale to 1)
DELETE /api/hosting/servers/:serverId        - Delete server
```

## Security Considerations

1. **Network Policies**: MCP servers can only receive traffic from ingress
2. **Resource Limits**: Prevent runaway containers
3. **Pod Security**: Non-root, read-only filesystem
4. **Secrets**: User API keys stored in K8s secrets, injected as env vars
5. **Rate Limiting**: At ingress level per server
6. **Authentication**: Server IDs are UUIDs (unguessable), future: API keys

## Scaling Considerations

1. **HorizontalPodAutoscaler**: Scale based on request rate
2. **Scale to Zero**: Use KEDA for scaling to zero when idle
3. **Node Affinity**: Dedicated node pool for MCP servers
4. **Registry Caching**: Local registry mirror for faster pulls

## Monitoring

1. **Prometheus**: Scrape metrics from HTTP wrapper
2. **Grafana**: Dashboard per server
3. **Alerts**: Failed deployments, high error rates
4. **Logging**: Centralized logging with Loki/ELK

## Cost Model

Per hosted server (approximate):
- CPU: 100m request, 500m limit
- Memory: 128Mi request, 256Mi limit
- Storage: None (stateless)

With scale-to-zero (KEDA):
- Idle servers cost nothing
- Active servers: ~$3/month at typical cloud rates
- Self-managed K8s: Only your infrastructure costs
