# Production image for the Angular frontend.
#
# Build context is THIS directory (packages/frontend) - the package has no
# dependency on @mcp-everything/shared, so it is self-contained. Build from
# here:
#   cd packages/frontend && docker build -t mcp-everything/frontend:local .
#
# There is no package-lock.json inside this directory (only the monorepo
# root has one via npm workspaces), so `npm install` is used rather than
# `npm ci`.

# ---- build ------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
# --configuration production applies angular.json's fileReplacements
# (environment.ts -> environment.prod.ts, apiUrl: '') - see
# src/environments/environment.prod.ts.
RUN npm run build:prod

# ---- runtime: nginx serving the static SPA, no /api proxying ---------------
FROM nginx:alpine AS runtime

COPY nginx.conf /etc/nginx/nginx.conf

# angular.json "outputPath": "dist" (legacy @angular-devkit/build-angular:browser
# builder - no /browser subfolder like the newer esbuild "application" builder).
COPY --from=build /app/dist /usr/share/nginx/html

# The stock nginx:alpine image already chowns /var/cache/nginx and the pid/log
# directories to the "nginx" user (uid/gid 101); nginx.conf redirects every
# other writable path (pid, temp dirs) under /tmp so nothing else needs it.
RUN mkdir -p /tmp/client_temp /tmp/proxy_temp /tmp/fastcgi_temp /tmp/uwsgi_temp /tmp/scgi_temp && \
    chown -R nginx:nginx /usr/share/nginx/html /tmp/client_temp /tmp/proxy_temp /tmp/fastcgi_temp /tmp/uwsgi_temp /tmp/scgi_temp

USER nginx

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- http://localhost:8080/healthz || exit 1

CMD ["nginx", "-g", "daemon off;"]
