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
 && pnpm --filter @fabrikka/bridge build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    ARTIFACT_DIR=/data/artifacts \
    FABRIKKA_DATA_DIR=/data
COPY --from=build --chown=node:node /app /app
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/fabrikka-entrypoint
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["fabrikka-entrypoint"]
