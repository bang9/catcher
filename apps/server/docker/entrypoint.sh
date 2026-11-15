#!/bin/sh
# Start the relay: apply database migrations, run the hourly cleanup Cloudflare's cron would run, serve on :8787.
set -e
cd /app/apps/server

# optional Worker secrets from the container environment
: > .dev.vars
if [ -n "$EXPO_ACCESS_TOKEN" ]; then echo "EXPO_ACCESS_TOKEN=$EXPO_ACCESS_TOKEN" >> .dev.vars; fi

pnpm exec wrangler d1 migrations apply catcher --local --persist-to /data

# hourly: drop expired envelopes and registration codes (wrangler.jsonc "triggers")
(
  while sleep 3600; do
    node -e "fetch('http://127.0.0.1:8787/__scheduled?cron=17+*+*+*+*').catch(() => {})"
  done
) &

exec pnpm exec wrangler dev \
  --ip 0.0.0.0 \
  --port 8787 \
  --persist-to /data \
  --show-interactive-dev-session=false \
  --test-scheduled
