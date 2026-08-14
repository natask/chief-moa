#!/usr/bin/env bash
set -euo pipefail

root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT
mkdir -p "$root/bin" "$root/systemd"
cat > "$root/bin/systemctl" <<'SH'
#!/usr/bin/env bash
test "$1" = daemon-reload
SH
cat > "$root/bin/id" <<'SH'
#!/usr/bin/env bash
test "$1" = -u
printf '0\n'
SH
cat > "$root/bin/chown" <<'SH'
#!/usr/bin/env bash
test "$1" = root:root
printf '%s\n' "$2" >>"$TEST_CHOWN_LOG"
SH
chmod +x "$root/bin/systemctl" "$root/bin/id" "$root/bin/chown"
cat > "$root/gateway.env" <<'ENV'
MOA_GATEWAY_TOKEN=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
MOA_DOMAIN=api.example.test
GATEWAY_PORT=8787
UNRELATED_INSTALL_SETTING=preserved
ENV

PATH="$root/bin:$PATH" TEST_CHOWN_LOG="$root/chown.log" MOA_ROOT="$root" ENV_FILE="$root/gateway.env" \
  MOA_PROMOTION_ENV_FILE="$root/promotion.env" MOA_SYSTEMD_DIR="$root/systemd" \
  bash "$(dirname "$0")/install-promotion-control-plane.sh" --install >/dev/null
checksum="$(shasum -a 256 "$root/gateway.env" "$root/promotion.env")"
PATH="$root/bin:$PATH" TEST_CHOWN_LOG="$root/chown.log" MOA_ROOT="$root" ENV_FILE="$root/gateway.env" \
  MOA_PROMOTION_ENV_FILE="$root/promotion.env" MOA_SYSTEMD_DIR="$root/systemd" \
  bash "$(dirname "$0")/install-promotion-control-plane.sh" --check >/dev/null
test "$checksum" = "$(shasum -a 256 "$root/gateway.env" "$root/promotion.env")"
test "$(stat -c '%a' "$root/promotion.env" 2>/dev/null || stat -f '%Lp' "$root/promotion.env")" = 600
test "$(stat -c '%a' "$root/gateway.env" 2>/dev/null || stat -f '%Lp' "$root/gateway.env")" = 600
test "$(grep -Ec '^MOA_(DEPLOY_REVIEWER|PREVIEW_DEPLOYER|PRODUCTION_PROMOTER|DEVELOPMENT_COORDINATOR)_TOKEN=[[:xdigit:]]{64}$' "$root/gateway.env")" = 4
test "$(grep -c '^UNRELATED_INSTALL_SETTING=preserved$' "$root/gateway.env")" = 1
test "$(grep -c '^MOA_DEVELOPMENT_COORDINATOR_TOKEN=' "$root/promotion.env")" = 0
tokens="$(sed -n -E 's/^MOA_(GATEWAY|DEPLOY_REVIEWER|PREVIEW_DEPLOYER|PRODUCTION_PROMOTER|DEVELOPMENT_COORDINATOR)_TOKEN=//p' "$root/gateway.env")"
test "$(printf '%s\n' "$tokens" | sort -u | wc -l | tr -d ' ')" = 5
test -f "$root/systemd/chief-moa-auto-update.service.d/promotion.conf"
test "$(wc -l <"$root/chown.log" | tr -d ' ')" = 3

collision_root="$root/collision"
mkdir -p "$collision_root"
for duplicate in \
  aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
  cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc \
  dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd; do
  cat > "$collision_root/gateway.env" <<ENV
MOA_GATEWAY_TOKEN=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
MOA_DEPLOY_REVIEWER_TOKEN=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
MOA_PREVIEW_DEPLOYER_TOKEN=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
MOA_PRODUCTION_PROMOTER_TOKEN=dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd
MOA_DEVELOPMENT_COORDINATOR_TOKEN=$duplicate
MOA_DOMAIN=api.example.test
ENV
  if MOA_ROOT="$collision_root" ENV_FILE="$collision_root/gateway.env" \
    bash "$(dirname "$0")/install-promotion-control-plane.sh" --check >/dev/null 2>&1; then
    echo "installer accepted a reused coordinator credential" >&2
    exit 1
  fi
done
echo "promotion control-plane installer test passed"
