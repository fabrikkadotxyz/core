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
  elif [ -n "${FLY_APP_NAME:-}" ]; then
    PUBLIC_URL="https://$FLY_APP_NAME.fly.dev"
  fi
  [ -n "${PUBLIC_URL:-}" ] && export PUBLIC_URL && echo "fabrikka: PUBLIC_URL is $PUBLIC_URL (from the platform)"
fi

# The platform's own address stays reachable after PUBLIC_URL moves to your
# domain (docs/operations.md, "The hostnames it answers to").
platform_host=""
if [ -n "${FLY_APP_NAME:-}" ]; then
  platform_host="$FLY_APP_NAME.fly.dev"
elif [ -n "${RENDER_EXTERNAL_HOSTNAME:-}" ]; then
  platform_host="$RENDER_EXTERNAL_HOSTNAME"
elif [ -n "${RAILWAY_PUBLIC_DOMAIN:-}" ]; then
  platform_host="$RAILWAY_PUBLIC_DOMAIN"
fi
if [ -n "$platform_host" ]; then
  export MCP_ALLOWED_HOSTS="${MCP_ALLOWED_HOSTS:+$MCP_ALLOWED_HOSTS,}$platform_host"
fi

# Render and Railway put one proxy in front: count it, so rate limits see the
# client, not the proxy (docs/operations.md, "Behind a proxy"). Set it to be explicit.
if [ -z "${FABRIKKA_TRUSTED_PROXIES:-}" ] && { [ -n "${RENDER_EXTERNAL_URL:-}" ] || [ -n "${RAILWAY_PUBLIC_DOMAIN:-}" ]; }; then
  export FABRIKKA_TRUSTED_PROXIES=1
fi
# Fly.io's X-Forwarded-For ends with the app's own address, so counting hops
# would be wrong there; its proxy sets Fly-Client-IP to the client instead.
if [ -z "${FABRIKKA_CLIENT_IP_HEADER:-}" ] && [ -n "${FLY_APP_NAME:-}" ]; then
  export FABRIKKA_CLIENT_IP_HEADER=Fly-Client-IP
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

# A deployment that extends the core (docs/operations.md) passes its own start
# command; with none, start the core's own server.
# M61: a backup a day into the data volume, sealed with a passphrase. Set
# FABRIKKA_BACKUP_DIR= (empty) to turn it off. Copy the archives, and the two
# keys, somewhere other than this volume: a backup beside its data is not one.
if [ -z "${FABRIKKA_BACKUP_DIR+x}" ]; then
  export FABRIKKA_BACKUP_DIR="$data/backups"
fi
if [ -n "${FABRIKKA_BACKUP_DIR:-}" ]; then
  mkdir -p "$FABRIKKA_BACKUP_DIR"
  if [ -z "${FABRIKKA_BACKUP_KEY:-}" ]; then
    bkeyfile="$data/backup.key"
    if [ ! -s "$bkeyfile" ]; then
      node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))" > "$bkeyfile"
      chmod 600 "$bkeyfile"
      echo "fabrikka: generated a backup passphrase in $bkeyfile (keep a copy elsewhere: a restore needs it)"
    fi
    FABRIKKA_BACKUP_KEY="$(cat "$bkeyfile")"
    export FABRIKKA_BACKUP_KEY
  fi
fi

if [ "$#" -gt 0 ]; then
  exec "$@"
fi
cd /app/apps/server
exec ./node_modules/.bin/tsx src/index.ts
