#!/usr/bin/env bash
# Install the two distinct Postgres role passwords required by the additive
# release-control database migration. This only edits the private gateway env
# file; it never prints values or restarts the active stack.

set -euo pipefail
umask 077

MOA_ROOT="${MOA_ROOT:-/opt/chief-moa}"
ENV_FILE="${ENV_FILE:-$MOA_ROOT/gateway.env}"
MODE="${1:---check}"

[ -f "$ENV_FILE" ] || { echo "Missing gateway env file: $ENV_FILE" >&2; exit 1; }
case "$MODE" in --check|--install) ;; *) echo "Usage: $0 [--check|--install]" >&2; exit 64 ;; esac

value() { sed -n "s/^${1}=//p" "$ENV_FILE" | tail -n 1; }

missing=()
for key in RELEASE_CONTROL_POSTGRES_PASSWORD RELEASE_CONTROL_PUBLISHER_POSTGRES_PASSWORD; do
  current="$(value "$key")"
  if [ "${#current}" -lt 32 ]; then
    [ "$MODE" = "--install" ] || { echo "$key is not configured" >&2; exit 1; }
    missing+=("$key")
  fi
done

if [ "${#missing[@]}" -gt 0 ]; then
  temporary="${ENV_FILE}.$$"
  cp -p "$ENV_FILE" "$temporary"
  for key in "${missing[@]}"; do
    printf '%s=%s\n' "$key" "$(openssl rand -hex 32)" >> "$temporary"
  done
  chmod 600 "$temporary"
  mv -f "$temporary" "$ENV_FILE"
fi

app_password="$(value RELEASE_CONTROL_POSTGRES_PASSWORD)"
publisher_password="$(value RELEASE_CONTROL_PUBLISHER_POSTGRES_PASSWORD)"
[ "${#app_password}" -ge 32 ] && [ "${#publisher_password}" -ge 32 ] \
  && [ "$app_password" != "$publisher_password" ] \
  || { echo "Release-control database credentials must be present and distinct" >&2; exit 1; }

echo "Release-control database credentials are ready; gateway restart is still operator-gated."
