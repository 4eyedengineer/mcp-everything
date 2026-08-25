# MCP Server Hosting Architecture

## Overview

This document describes the architecture for dynamically hosting generated MCP servers on a self-managed Kubernetes cluster.

## Control Plane

The backend creates, patches and deletes each hosted server's Kubernetes
objects **directly against the Kubernetes API** - see
`packages/backend/src/hosting/services/k8s-control-plane.service.ts`.

There is no GitOps repository in this path any more. The previous design
committed per-server YAML to a separate `mcp-server-deployments` repo and
reported success on commit. That was removed because:

- **Nothing consumed that repo.** The only ArgoCD `Application` in this cluster
  (`k8s/argocd/application.yaml`) points at *this* repo's
  `k8s/overlays/homelab`. The `ApplicationSet` that would have watched
  `servers/*` existed only as a fenced code block in this document - there was
  never an `applicationset.yaml` file anywhere.
- **Status was fiction.** `status` was set to `running` the moment the git
  commit succeeded, and nothing ever reconciled it. A pod in
  `CrashLoopBackOff` reported `running` indefinitely, and the status endpoint
  derived replica counts from that same string.
- **Deletion never deleted.** Git retains history, so a "deleted" server (and
  anything embedded in its manifests) stayed recoverable forever - wrong for
  account deletion.
- **Concurrent deploys raced.** The commit sequence had no conflict handling
  and would 422 when two deploys overlapped.

ArgoCD still manages the *platform itself* (backend/frontend/postgres via
`k8s/overlays/homelab`). It is simply not in the loop for user-hosted servers.

### Cluster prerequisites

`k8s/mcp-servers/` must be applied before the backend can host anything:

```bash
kubectl apply -k k8s/mcp-servers
```

It creates the `mcp-servers` namespace (nothing previously did), a namespaced
`Role` + `RoleBinding` granting the backend's ServiceAccount
deployment/service/secret/pod access **in that namespace only** (not a
ClusterRole), the `mcp-server-runtime` ServiceAccount hosted pods run as, and
the ResourceQuota/LimitRange/NetworkPolicy.

### Desired vs observed state

`hosted_servers` now separates intent from reality:

| Column | Written by | Meaning |
| --- | --- | --- |
| `desired_state` | `HostingService` | What the user asked for: `running` / `stopped` / `deleted` |
| `observed_status` | `K8sReconcilerService` | What the cluster reports: `running` / `progressing` / `stopped` / `degraded` / `failed` / `missing` / `unknown` |
| `observed_message` | `K8sReconcilerService` | Real reason, e.g. `CrashLoopBackOff: back-off 5m0s restarting failed container` |
| `observed_replicas`, `observed_ready_replicas` | `K8sReconcilerService` | Real counts from the Deployment |
| `observed_at` | `K8sReconcilerService` | Observation freshness |
| `status` | `K8sReconcilerService` (derived) | Legacy display value, kept so the existing frontend keeps working |

`status` is deliberately **not** renamed or dropped - the Angular frontend
reads it and its existing union of values. The reconciler recomputes it from
(`desired_state`, `observed_status`) on every pass, so old readers see the
same vocabulary while new readers get the honest split.

### Reconciler: poll, not watch

`K8sReconcilerService` polls every `K8S_RECONCILE_INTERVAL_MS` (default 10s),
using exactly two label-filtered list calls per pass regardless of how many
servers are hosted. A watch was considered and rejected: it needs
resourceVersion/410-Gone/reconnect handling whose failure mode is *silent
staleness* (precisely the bug being fixed), it still needs a periodic resync
to catch out-of-band deletions, and it would turn a CrashLooping pod's event
stream into a flood of database writes. The cost is up to ~10s of status
latency, which is acceptable for a deployment-status UI.

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

### 2. Per-server object naming

| Object | Name |
| --- | --- |
| Deployment | `mcp-{server-id}` |
| Service | `mcp-{server-id}` (ClusterIP) |
| Secret | `mcp-{server-id}-env` (only when the server has user env vars) |

All three carry `app=mcp-server` and `server-id={server-id}` labels; the
reconciler lists by the former and keys by the latter.

### 3. Secret handling

User-supplied environment variables go into a Kubernetes `Secret` and reach the
container via `envFrom.secretRef`. They are **never** written into the
Deployment as literal `value:` entries.

This is load-bearing, not cosmetic. In the previous design the manifest
generator inlined them as literals and `GitOpsService` would have committed
that YAML to a **public** GitHub repo. The only reason user credentials were
not actually leaked is that `envVars` were silently dropped before ever
reaching the Kubernetes path. Passing them through is safe now precisely
because the Secret path exists.

Only three platform-owned, non-secret values remain inlined on the Deployment:
`MCP_SERVER_ID`, `MCP_TRANSPORT=http` and `PORT=3000`.

### 4. Per-Server Kubernetes Resources

Built as typed `V1Deployment` / `V1Service` / `V1Secret` objects by
`ManifestGeneratorService` (single source of truth - it no longer emits YAML
strings, since nothing commits YAML any more).

**Deployment** (abridged; note the hardening, none of which the previous
generated pod spec had):
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mcp-{server-id}
  namespace: mcp-servers
  labels: { app: mcp-server, server-id: "{server-id}" }
spec:
  replicas: 1
  selector:
    matchLabels: { app: mcp-server, server-id: "{server-id}" }
  template:
    spec:
      serviceAccountName: mcp-server-runtime
      automountServiceAccountToken: false      # hosted code must not reach the API
      imagePullSecrets: [{ name: "{K8S_IMAGE_PULL_SECRET}" }]   # when configured
      securityContext:
        runAsNonRoot: true
        runAsUser: 1001
        seccompProfile: { type: RuntimeDefault }
      containers:
        - name: mcp-server
          image: ghcr.io/4eyedengineer/mcp-servers/{server-id}:latest
          ports: [{ name: http, containerPort: 3000 }]
          env:                                  # platform-owned only
            - { name: MCP_SERVER_ID, value: "{server-id}" }
            - { name: MCP_TRANSPORT, value: "http" }
            - { name: PORT, value: "3000" }
          envFrom:                              # user env vars, when present
            - secretRef: { name: mcp-{server-id}-env, optional: false }
          securityContext:
            runAsNonRoot: true
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: { drop: [ALL] }
          volumeMounts: [{ name: tmp, mountPath: /tmp }]
          livenessProbe:  { httpGet: { path: /health, port: 3000 } }
          readinessProbe: { httpGet: { path: /health, port: 3000 } }
      volumes: [{ name: tmp, emptyDir: {} }]    # makes read-only root viable
```

**Service**: ClusterIP, port 80 -> targetPort 3000, selected by
`app=mcp-server,server-id={server-id}`.

**Ingress**: none. See the routing note in the cluster diagram above -
per-server Ingress, wildcard DNS and cert-manager are deferred pending the
gateway decision, and the backend's RBAC deliberately grants no Ingress
permission at all.

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

  -- Status: intent vs reality (migration 1754200000000)
  desired_state VARCHAR(20) DEFAULT 'running',   -- running | stopped | deleted
  observed_status VARCHAR(20),                   -- running | progressing | stopped
                                                 -- | degraded | failed | missing | unknown
  observed_message TEXT,                         -- real reason from the cluster
  observed_replicas INTEGER,
  observed_ready_replicas INTEGER,
  observed_at TIMESTAMP,

  -- Legacy display value, DERIVED from the two above by the reconciler.
  -- Kept (not renamed) because the frontend reads it.
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

1. **Network Policies**: hosted pods accept ingress only from the
   `mcp-everything` namespace (the backend/gateway), on port 3000
2. **Resource Limits**: ResourceQuota + LimitRange on the namespace
3. **Pod Security**: non-root, read-only root filesystem, all capabilities
   dropped, `RuntimeDefault` seccomp, dedicated ServiceAccount with
   `automountServiceAccountToken: false`
4. **Secrets**: user API keys stored in K8s Secrets and injected via
   `envFrom` - never inlined in a Deployment, never committed to git
5. **Backend RBAC**: namespaced Role + RoleBinding limited to `mcp-servers`,
   no ClusterRole, no Ingress permission
6. **Authentication**: server IDs are unguessable; future: API keys

## Scaling Considerations

1. **HorizontalPodAutoscaler**: Scale based on request rate
2. **Scale to Zero**: Use KEDA for scaling to zero when idle
3. **Node Affinity**: Dedicated node pool for MCP servers
4. **Registry Caching**: Local registry mirror for faster pulls

## Monitoring

1. **Prometheus**: scrape metrics from the generated servers' HTTP listener
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
