#!/bin/sh
# One-time setup for self-hosting Fabrikka (M39): writes .env next to this
# script with every secret generated. You only choose the domain.
#   ./init.sh                      asks for the domain
#   ./init.sh fabrikka.example.com
set -eu
cd "$(dirname "$0")"

if [ -f .env ]; then
  echo "init.sh: .env already exists; delete it first to start over (that changes the secrets)." >&2
  exit 1
fi

domain="${1:-}"
if [ -z "$domain" ]; then
  printf 'The domain Fabrikka will be reached at (its DNS must point at this server): '
  read -r domain
fi
[ -n "$domain" ] || { echo "init.sh: a domain is required" >&2; exit 1; }

secret() { head -c "$1" /dev/urandom | base64 | tr -d '\n'; }
hexsecret() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }

umask 077
cat > .env <<ENV
# Written by init.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ). Keep it private, and back it up.
FABRIKKA_DOMAIN=$domain
PUBLIC_URL=https://$domain
POSTGRES_PASSWORD=$(hexsecret 24)
FABRIKKA_ENCRYPTION_KEY=$(secret 32)
# Optional: GitHub needs an OAuth App per instance (docs/operations.md).
# GITHUB_OAUTH_CLIENT_ID=
# GITHUB_OAUTH_CLIENT_SECRET=
ENV

echo "Wrote $(pwd)/.env for https://$domain"
echo "Next: docker compose up -d, then open https://$domain"
echo "The setup code is in: docker compose logs server"
