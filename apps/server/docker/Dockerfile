# The catcher relay without Cloudflare: the same Worker on workerd (Cloudflare's open-source runtime, via wrangler's
# local mode), its D1 database and realtime hub kept as SQLite files in /data. Build from the repo root:
#   docker build -f apps/server/docker/Dockerfile -t catcher-relay .
# For a public relay put it behind HTTPS (compose.yaml does that with Caddy).
FROM node:24-bookworm-slim

ENV CI=1 \
    WRANGLER_SEND_METRICS=false \
    NODE_ENV=production

# workerd needs the system CA list for outgoing HTTPS (push notifications)
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable

WORKDIR /app
# every workspace manifest, so the lockfile matches; only the relay's dependencies get installed
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/client/package.json packages/client/
COPY apps/server/package.json apps/server/
COPY apps/mobile/package.json apps/mobile/
RUN pnpm install --frozen-lockfile --filter @catcher/server... --prod=false

COPY packages/protocol packages/protocol
COPY apps/server apps/server

WORKDIR /app/apps/server
VOLUME /data
EXPOSE 8787
ENTRYPOINT ["/app/apps/server/docker/entrypoint.sh"]
