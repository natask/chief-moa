#!/usr/bin/env bash
set -euo pipefail

root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT
cat > "$root/gateway.env" <<'ENV'
MOA_GATEWAY_TOKEN=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
ENV
chmod 600 "$root/gateway.env"

installer="$(dirname "$0")/install-release-control-database-credentials.sh"
if MOA_ROOT="$root" ENV_FILE="$root/gateway.env" bash "$installer" --check >/dev/null 2>&1; then
  echo "Credential check unexpectedly accepted a legacy environment." >&2
  exit 1
fi

MOA_ROOT="$root" ENV_FILE="$root/gateway.env" bash "$installer" --install >/dev/null
checksum="$(shasum -a 256 "$root/gateway.env")"
MOA_ROOT="$root" ENV_FILE="$root/gateway.env" bash "$installer" --check >/dev/null
test "$checksum" = "$(shasum -a 256 "$root/gateway.env")"
test "$(stat -c '%a' "$root/gateway.env" 2>/dev/null || stat -f '%Lp' "$root/gateway.env")" = 600
test "$(grep -Ec '^RELEASE_CONTROL_(PUBLISHER_)?POSTGRES_PASSWORD=.{32,}$' "$root/gateway.env")" = 2

app_password="$(sed -n 's/^RELEASE_CONTROL_POSTGRES_PASSWORD=//p' "$root/gateway.env" | tail -n 1)"
publisher_password="$(sed -n 's/^RELEASE_CONTROL_PUBLISHER_POSTGRES_PASSWORD=//p' "$root/gateway.env" | tail -n 1)"
test "$app_password" != "$publisher_password"
MOA_ROOT="$root" ENV_FILE="$root/gateway.env" bash "$installer" --enable >/dev/null
grep -Fxq 'MOA_RELEASE_CONTROL_ENABLED=1' "$root/gateway.env"
grep -Fxq 'MOA_RELEASE_CONTROL_TENANT_ID=tenant_personal' "$root/gateway.env"
grep -Fxq 'MOA_RELEASE_CONTROL_OWNER_ID=owner_personal' "$root/gateway.env"
test "$(grep -c '^MOA_RELEASE_CONTROL_ENABLED=' "$root/gateway.env")" = 1
echo "release-control database credential installer test passed"
