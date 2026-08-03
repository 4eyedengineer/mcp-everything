# mcp-runner

One shared, multi-arch container image that runs **every** hosted MCP server.
It replaces per-server image builds entirely.

## Why

The backend pod has no docker binary and no docker socket, so it cannot build a
per-server image — that was the last blocker on hosted MCP servers. Instead of
giving the backend a builder (and the privileges that implies), the build moves
into the pod that will run the server: this image fetches the generated source
at startup, compiles it, and serves it.

It also fixes an architecture problem. The cluster is 4× arm64 + 2× amd64 and
generated Deployments carry no `nodeSelector`, so per-server single-arch images
would `ImagePullBackOff` on roughly two thirds of schedulings. One image built
multi-arch by CI runs anywhere.

## How it is wired

The image is used **twice** in a generated server's Deployment — as the
initContainer and as the main container — sharing a single `emptyDir` at
`/app`.

| Phase | Command | Does |
|---|---|---|
| initContainer | `mcp-runner-init` | fetch source tarball → extract to `/app` → seed pre-baked deps → `npm install` → `npm run build` |
| main container | `mcp-runner-serve` | `node dist/index.js` with `MCP_TRANSPORT=http` |

The generated server then serves MCP Streamable HTTP at `POST /mcp` and a
liveness endpoint at `GET /health`.

### initContainer environment

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `MCP_SOURCE_URL` | yes | — | e.g. `https://mcpeverything.com/api/hosting/servers/<serverId>/source` |
| `MCP_SOURCE_TOKEN` | yes | — | bearer token, injected from a Secret. Never logged. |
| `MCP_APP_DIR` | no | `/app` | shared volume mount point |
| `MCP_SOURCE_STRIP` | no | `auto` | `tar --strip-components`; auto-detected from where `package.json` sits |
| `MCP_SOURCE_TIMEOUT` | no | `120` | per-attempt curl timeout, seconds |
| `MCP_SKIP_PREBAKE` | no | `0` | `1` disables the pre-baked dependency seed (diagnostics only) |

### main container environment

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP listen port |
| `MCP_TRANSPORT` | `http` | forced; hosting always wants Streamable HTTP |
| `MCP_ENTRYPOINT` | `dist/index.js` | compiled entrypoint |

### Required pod securityContext

`/app` is an `emptyDir`, and the runner runs as **uid 1000 (non-root)**.
Kubernetes does not apply the image's directory ownership to a mounted
`emptyDir`, so the pod must set:

```yaml
securityContext:
  fsGroup: 1000
```

Without it the initContainer fails immediately with an explicit
"App directory '/app' is not writable by uid 1000" message.

## Cold start

Cold start is the cost of this design, so the image pre-bakes the exact
dependency set that `generatePackageJson()` emits
(`packages/backend/src/orchestration/refinement.service.ts`). The init script
copies that tree into `/app/node_modules`, which turns the startup install into
a cache hit instead of a cold download.

Measured on an amd64 cluster node (image already present, empty volume,
reference MCP server):

| Phase | With pre-bake | Without (`MCP_SKIP_PREBAKE=1`) |
|---|---|---|
| fetch + extract | <1 s | <1 s |
| seed node_modules | 2 s | — |
| `npm install` | **5 s** | **40 s** |
| `npm run build` (tsc) | 21 s | 23 s |
| init total | **28 s** | 63 s |
| main container → `/health` 200 | 4–5 s | 4–5 s |
| **end-to-end cold start** | **~37 s** | ~68 s |

`tsc` dominates what remains. Every init log line carries an elapsed-time
prefix so a slow start can be attributed to a phase from `kubectl logs` alone.

Keeping `prebake/package.json` in sync with `generatePackageJson()` matters: a
version that drifts is a real network download on every cold start.

## Failure behaviour

Every failure path exits non-zero with a message naming the failed step and
what to check — a pod in `Init:Error` must be diagnosable from
`kubectl logs -c <init>` alone. Covered: missing/invalid env, unreachable
backend, HTTP 401/403 (credentials, without ever printing the token), 404,
non-gzip response, unrecognisable archive layout, `npm install` failure,
`tsc` failure, and a build that emits no `dist/index.js`.

## Security

- Runs as uid 1000, never root; `/app` is the only path it needs to write.
- `npm install --ignore-scripts` — generated code is AI-authored and
  user-influenced, so npm lifecycle scripts are never executed.
- `MCP_SOURCE_TOKEN` is passed to curl through a config file on stdin, so it
  never appears in argv (and therefore never in `/proc`, `ps`, or a crash
  dump). Verified: it appears in neither the logs nor any file in the volume.
- The pre-baked dependency tree stays root-owned so the application user
  cannot tamper with it.

## Building

CI builds and pushes this on changes under `packages/mcp-runner/**` — see
`.github/workflows/deploy-mcp-runner.yml`. Manually:

```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  -t harbor.192.168.1.240.nip.io/mcp-everything/mcp-runner:<sha> \
  --push packages/mcp-runner
```

Multi-arch is not optional and cannot be faked: on a host without the buildx
plugin, `docker build --platform linux/arm64` **silently produces an amd64
image**. Always confirm with `docker buildx imagetools inspect`.
