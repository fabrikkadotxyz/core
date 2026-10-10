# Fabrikka, the whole server in one image (M39, docs/roadmap.md).
# The web app, the API, the MCP endpoint and the instance's own client
# (/install.sh). Everything it keeps lives in /data. Build from the repo root:
#   docker build -f docker/Dockerfile -t fabrikka .

FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @fabrikka/web build \
 && pnpm --filter @fabrikka/bridge build \
 && pnpm --filter @fabrikka/server deploy --prod --legacy /out/server

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    ARTIFACT_DIR=/data/artifacts \
    FABRIKKA_DATA_DIR=/data
# Only what runs: the server with its production dependencies (tsx included,
# since the server runs its TypeScript directly), the built web app and the
# built client, in the layout the server's paths expect. No build tools.
COPY --from=build --chown=node:node /out/server /app/apps/server
COPY --from=build --chown=node:node /app/apps/web/dist /app/apps/web/dist
COPY --from=build --chown=node:node /app/packages/bridge/dist /app/packages/bridge/dist
# The built-in themes (M44). The instance's own go in /data/themes.
COPY --from=build --chown=node:node /app/themes /app/themes
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/fabrikka-entrypoint
RUN mkdir -p /data && chown node:node /data
# No USER here: platforms mount /data as root (Render, Railway), so the
# entrypoint starts as root only to hand /data to `node`, then runs as `node`.
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["fabrikka-entrypoint"]
