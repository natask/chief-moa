#!/usr/bin/env bash
# Prepare or enable owner-only Better Auth without printing credentials or
# restarting the active gateway. Legacy MOA_GATEWAY_TOKEN remains untouched.

set -euo pipefail
umask 077

MOA_ROOT="${MOA_ROOT:-/opt/chief-moa}"
ENV_FILE="${ENV_FILE:-$MOA_ROOT/gateway.env}"
MODE="--check"
OWNER_EMAIL=""
ORIGIN=""

while [ $# -gt 0 ]; do
  case "$1" in
    --check|--prepare|--enable) MODE="$1"; shift ;;
    --owner-email) OWNER_EMAIL="${2:-}"; shift 2 ;;
    --origin) ORIGIN="${2:-}"; shift 2 ;;
    *) echo "Usage: $0 [--check|--prepare|--enable] [--owner-email EMAIL --origin HTTPS_ORIGIN]" >&2; exit 64 ;;
  esac
done

[ -f "$ENV_FILE" ] || { echo "Missing gateway env file: $ENV_FILE" >&2; exit 1; }
value() { sed -n "s/^${1}=//p" "$ENV_FILE" | tail -n 1; }

if [ "$MODE" != "--check" ]; then
  [[ "$OWNER_EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] \
    || { echo "--owner-email must be a valid email address" >&2; exit 64; }
  [[ "$ORIGIN" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] \
    || { echo "--origin must be a canonical HTTPS origin without a path" >&2; exit 64; }

  temporary="${ENV_FILE}.$$"
  cp -p "$ENV_FILE" "$temporary"
  upsert() {
    local key="$1" replacement="$2" next="${temporary}.next"
    awk -v key="$key" -v replacement="$replacement" '
      BEGIN { written = 0 }
      index($0, key "=") == 1 {
        if (!written) { print key "=" replacement; written = 1 }
        next
      }
      { print }
      END { if (!written) print key "=" replacement }
    ' "$temporary" > "$next"
    mv -f "$next" "$temporary"
  }
  secret="$(value BETTER_AUTH_SECRET)"
  [ "${#secret}" -ge 32 ] || secret="$(openssl rand -hex 32)"
  upsert BETTER_AUTH_URL "$ORIGIN"
  upsert BETTER_AUTH_SECRET "$secret"
  owner_lower="$(printf '%s' "$OWNER_EMAIL" | tr '[:upper:]' '[:lower:]')"
  upsert BETTER_AUTH_OWNER_EMAIL "$owner_lower"
  upsert BETTER_AUTH_TRUSTED_ORIGINS "$ORIGIN"
  if [ "$MODE" = "--enable" ]; then
    upsert MOA_AUTH better-auth
  fi
  chmod 600 "$temporary"
  mv -f "$temporary" "$ENV_FILE"
fi

secret="$(value BETTER_AUTH_SECRET)"
origin="$(value BETTER_AUTH_URL)"
owner="$(value BETTER_AUTH_OWNER_EMAIL)"
trusted="$(value BETTER_AUTH_TRUSTED_ORIGINS)"
[ "${#secret}" -ge 32 ] || { echo "BETTER_AUTH_SECRET is missing or too short" >&2; exit 1; }
[[ "$origin" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] \
  || { echo "BETTER_AUTH_URL is not a canonical HTTPS origin" >&2; exit 1; }
[[ "$owner" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] \
  || { echo "BETTER_AUTH_OWNER_EMAIL is invalid" >&2; exit 1; }
[ "$trusted" = "$origin" ] || { echo "BETTER_AUTH_TRUSTED_ORIGINS must equal the owner origin" >&2; exit 1; }
if [ "$MODE" = "--check" ] || [ "$MODE" = "--enable" ]; then
  [ "$(value MOA_AUTH)" = "better-auth" ] || { echo "MOA_AUTH is not enabled" >&2; exit 1; }
fi

if [ "$MODE" = "--prepare" ]; then
  echo "Better Auth configuration is prepared but not enabled; active gateway unchanged."
else
  echo "Better Auth configuration is ready; gateway restart remains promotion-gated."
fi
