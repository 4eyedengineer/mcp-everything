# Production image for the NestJS backend.
#
# Build context is THIS directory (packages/backend), not the monorepo root -
# the package has no dependency on @mcp-everything/shared (verified: no
# `@mcp-everything/shared` import anywhere in src/), so it is fully
# self-contained. Build from here:
#   cd packages/backend && docker build -t mcp-everything/backend:local .
#
# There is no package-lock.json inside this directory (only the monorepo
# root has one, via npm workspaces), so `npm install` is used rather than
# `npm ci`. If a package-lock.json is added here later, switch to `npm ci`
# for reproducible installs.

# ---- deps: full install (incl. devDependencies) for the build stage -------
FROM node:22-alpine AS deps
# python3/make/g++ are required to compile native addons at install time:
# bcrypt and isolated-vm both ship native code and have no prebuilt musl/alpine
# binaries, so they build from source here.
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package*.json ./
RUN npm install

# ---- build: compile TypeScript -> dist/ ------------------------------------
FROM deps AS build
COPY . .
RUN npm run build

# ---- prod-deps: production-only install (own stage so build tools and ------
# devDependencies never reach the final image) --------------------------------
FROM node:22-alpine AS prod-deps
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# ---- runtime ----------------------------------------------------------------
FROM node:22-alpine AS runtime

# curl: container HEALTHCHECK + k8s exec-free debugging.
# dumb-init: reap zombies / forward signals correctly as PID 1.
# libstdc++ + libgcc: runtime shared libs for the native addons (bcrypt,
# isolated-vm) compiled against g++ in the deps stages above - alpine does not
# include them by default and the addons segfault/fail to load without them.
RUN apk add --no-cache curl dumb-init libstdc++ libgcc

RUN addgroup -g 1001 -S nestjs && adduser -S nestjs -u 1001 -G nestjs

WORKDIR /app

COPY --from=prod-deps --chown=nestjs:nestjs /app/node_modules ./node_modules
COPY --from=build --chown=nestjs:nestjs /app/dist ./dist
COPY --chown=nestjs:nestjs package*.json ./

# Fallback location for GENERATED_SERVERS_DIR when it is not overridden onto
# a mounted volume (e.g. plain `docker run` outside of k8s). In the homelab
# deployment this is overridden to /data/generated-servers, backed by an
# emptyDir - see k8s/base/backend/deployment.yaml.
RUN mkdir -p /app/generated-servers /data/generated-servers && \
    chown -R nestjs:nestjs /app/generated-servers /data/generated-servers

USER nestjs

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:3000/api/v1/health/live || exit 1

EXPOSE 3000

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]
