#!/usr/bin/env bash
set -euo pipefail

test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT
printf 'MOA_GATEWAY_TOKEN=%064d\n' 0 > "$test_root/gateway.env"
chmod 600 "$test_root/gateway.env"
installer="$(dirname "$0")/install-better-auth.sh"

if MOA_ROOT="$test_root" ENV_FILE="$test_root/gateway.env" bash "$installer" --check >/dev/null 2>&1; then
  echo "Better Auth check unexpectedly accepted an unprepared environment." >&2
  exit 1
fi

MOA_ROOT="$test_root" ENV_FILE="$test_root/gateway.env" bash "$installer" \
  --prepare --owner-email Owner@Example.com --origin https://api.example.com >/dev/null
grep -q '^BETTER_AUTH_OWNER_EMAIL=owner@example.com$' "$test_root/gateway.env"
grep -q '^BETTER_AUTH_URL=https://api.example.com$' "$test_root/gateway.env"
! grep -q '^MOA_AUTH=better-auth$' "$test_root/gateway.env"
prepared_checksum="$(shasum -a 256 "$test_root/gateway.env")"

MOA_ROOT="$test_root" ENV_FILE="$test_root/gateway.env" bash "$installer" \
  --enable --owner-email owner@example.com --origin https://api.example.com >/dev/null
grep -q '^MOA_AUTH=better-auth$' "$test_root/gateway.env"
test "$(grep -Ec '^BETTER_AUTH_SECRET=.{32,}$' "$test_root/gateway.env")" = 1
test "$(stat -c '%a' "$test_root/gateway.env" 2>/dev/null || stat -f '%Lp' "$test_root/gateway.env")" = 600
MOA_ROOT="$test_root" ENV_FILE="$test_root/gateway.env" bash "$installer" --check >/dev/null
enabled_checksum="$(shasum -a 256 "$test_root/gateway.env")"
test "$prepared_checksum" != "$enabled_checksum"
MOA_ROOT="$test_root" ENV_FILE="$test_root/gateway.env" bash "$installer" \
  --enable --owner-email owner@example.com --origin https://api.example.com >/dev/null
test "$enabled_checksum" = "$(shasum -a 256 "$test_root/gateway.env")"

echo "Better Auth configuration installer test passed"
