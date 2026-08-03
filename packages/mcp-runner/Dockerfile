# syntax=docker/dockerfile:1.7
#
# Shared "MCP runner" image.
#
# One image serves every hosted MCP server, replacing per-server image builds
# entirely. It is used TWICE in a generated server's Deployment, sharing a
# single emptyDir mounted at /app:
#
#   initContainer -> mcp-runner-init   (fetch source tarball, install, build)
#   container     -> mcp-runner-serve  (node dist/index.js, MCP_TRANSPORT=http)
#
# Why this exists: the backend pod has no docker binary and no docker socket,
# so it cannot build a per-server image. Rather than granting it a builder, we
# removed the build step from the deploy path.
#
# Why multi-arch: the cluster is 4x arm64 + 2x amd64 and generated Deployments
# carry no nodeSelector, so a single-arch image would ImagePullBackOff on
# roughly two thirds of schedulings.

ARG NODE_IMAGE=node:22-alpine

# ---------------------------------------------------------------------------
# Stage 1: prebake - ALWAYS runs on the native build platform.
#
# Every dependency baked here is pure JavaScript (@modelcontextprotocol/sdk,
# zod, axios, typescript, @types/node ship no compiled binaries), so the
# resulting node_modules tree is architecture-independent and can be copied
# verbatim into the arm64 runtime stage.
#
# Pinning this stage to $BUILDPLATFORM is load-bearing, not cosmetic: running
# `npm install` under qemu-aarch64 emulation on this cluster reliably dies
# with TLS resets partway through the downloads. Keeping every npm/network
# operation on the native builder sidesteps emulation completely.
# ---------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS prebake

WORKDIR /prebake

# Only the manifest, so this layer caches on dependency changes alone.
COPY prebake/package.json ./package.json

# --ignore-scripts: nothing here needs lifecycle scripts, and skipping them
# keeps the build hermetic.
RUN npm install --ignore-scripts --no-audit --no-fund \
    && rm -f package-lock.json

# ---------------------------------------------------------------------------
# Stage 2: runtime - built for the TARGET platform.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

# curl: fetching the source tarball with a bearer token, with retries and a
#       real HTTP status code we can turn into an actionable error message.
# tar:  busybox tar handles our tarballs, but GNU tar's --strip-components and
#       error reporting are markedly better when something is malformed.
RUN apk add --no-cache curl tar

# Pre-baked dependency tree. The init script copies this into /app/node_modules
# so that the generated project's `npm install` is almost entirely a cache hit.
#
# Deliberately left owned by root and NOT by the runtime user: the application
# process must not be able to tamper with the baked dependency tree. The init
# script copies it out with a tar pipe precisely so that a non-root user can
# read it without needing to preserve ownership.
COPY --from=prebake /prebake/node_modules /opt/mcp-runner/node_modules

COPY bin/mcp-runner-init /usr/local/bin/mcp-runner-init
COPY bin/mcp-runner-serve /usr/local/bin/mcp-runner-serve
RUN chmod 0755 /usr/local/bin/mcp-runner-init /usr/local/bin/mcp-runner-serve

# /app is the ONLY path the container needs to write. It is an emptyDir shared
# between the initContainer and the main container in Kubernetes. Creating it
# owned by the unprivileged `node` user (uid 1000, already present in the base
# image) also means a plain `docker volume` mounted here inherits that
# ownership, so local runs behave like the cluster.
#
# NOTE for the Deployment author: Kubernetes does NOT inherit this ownership
# for an emptyDir. Set `securityContext.fsGroup: 1000` on the pod so the
# non-root user can write to the mounted volume.
RUN mkdir -p /app && chown 1000:1000 /app

ENV MCP_RUNNER_PREBAKE=/opt/mcp-runner/node_modules

# Keep npm's cache inside the one writable path, so the image stays compatible
# with readOnlyRootFilesystem. Only genuinely new dependencies (ones that are
# not pre-baked) ever land here.
ENV npm_config_cache=/app/.npm \
    npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false \
    MCP_TRANSPORT=http \
    PORT=3000 \
    NODE_ENV=production

WORKDIR /app
USER 1000:1000

EXPOSE 3000

# Local/compose convenience only; Kubernetes uses its own probes.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 || exit 1

# Default to serving. The Deployment overrides `command` for the initContainer.
CMD ["mcp-runner-serve"]
