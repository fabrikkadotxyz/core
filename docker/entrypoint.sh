#!/bin/sh
# Start the Fabrikka server (M39). Migrations run inside the server at start;
# this only makes sure there's an encryption key, so a fresh deploy never has
# to invent one.
set -eu

data="${FABRIKKA_DATA_DIR:-/data}"
mkdir -p "$data" "${ARTIFACT_DIR:-$data/artifacts}"

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
