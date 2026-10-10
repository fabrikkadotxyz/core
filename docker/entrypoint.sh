#!/bin/sh
# Start the Fabrikka server (M39). Migrations run inside the server at start;
# this only makes sure there's an encryption key, so a fresh deploy never has
# to invent one.
set -eu

data="${FABRIKKA_DATA_DIR:-/data}"

# Started as root (a platform mounted /data as root): give the data directory to
# the unprivileged `node` user, then run this script again as `node`. The server
# itself never runs as root.
if [ "$(id -u)" = 0 ]; then
  mkdir -p "$data"
  chown node:node "$data"
  exec setpriv --reuid=node --regid=node --init-groups "$0" "$@"
fi

mkdir -p "$data" "${ARTIFACT_DIR:-$data/artifacts}"

# Where the instance is reached. Set it to be explicit; otherwise take what the
# platform says about its own address (M40), so a one-click deploy asks nothing.
if [ -z "${PUBLIC_URL:-}" ]; then
  if [ -n "${RENDER_EXTERNAL_URL:-}" ]; then
    PUBLIC_URL="$RENDER_EXTERNAL_URL"
  elif [ -n "${RAILWAY_PUBLIC_DOMAIN:-}" ]; then
    PUBLIC_URL="https://$RAILWAY_PUBLIC_DOMAIN"
  fi
  [ -n "${PUBLIC_URL:-}" ] && export PUBLIC_URL && echo "fabrikka: PUBLIC_URL is $PUBLIC_URL (from the platform)"
fi

# No key configured: generate one into the data volume once, and reuse it.
# Losing it means reconnecting integrations, never losing a room.
if [ -z "${FABRIKKA_ENCRYPTION_KEY:-}" ]; then
  keyfile="$data/encryption.key"
  if [ ! -s "$keyfile" ]; then
    node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))" > "$keyfile"
    chmod 600 "$keyfile"
    echo "fabrikka: generated an encryption key in $keyfile (back it up with the data volume)"
  fi
  FABRIKKA_ENCRYPTION_KEY="$(cat "$keyfile")"
  export FABRIKKA_ENCRYPTION_KEY
fi

cd /app/apps/server
exec ./node_modules/.bin/tsx src/index.ts
