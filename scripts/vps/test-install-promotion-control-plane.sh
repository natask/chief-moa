#!/usr/bin/env bash
set -euo pipefail

root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT
mkdir -p "$root/bin" "$root/systemd"
cat > "$root/bin/systemctl" <<'SH'
#!/usr/bin/env bash
test "$1" = daemon-reload
SH
chmod +x "$root/bin/systemctl"
cat > "$root/gateway.env" <<'ENV'
MOA_GATEWAY_TOKEN=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
MOA_DOMAIN=api.example.test
GATEWAY_PORT=8787
ENV

PATH="$root/bin:$PATH" MOA_ROOT="$root" ENV_FILE="$root/gateway.env" \
  MOA_PROMOTION_ENV_FILE="$root/promotion.env" MOA_SYSTEMD_DIR="$root/systemd" \
  bash "$(dirname "$0")/install-promotion-control-plane.sh" --install >/dev/null
checksum="$(shasum -a 256 "$root/gateway.env" "$root/promotion.env")"
PATH="$root/bin:$PATH" MOA_ROOT="$root" ENV_FILE="$root/gateway.env" \
  MOA_PROMOTION_ENV_FILE="$root/promotion.env" MOA_SYSTEMD_DIR="$root/systemd" \
  bash "$(dirname "$0")/install-promotion-control-plane.sh" --check >/dev/null
test "$checksum" = "$(shasum -a 256 "$root/gateway.env" "$root/promotion.env")"
test "$(stat -f '%Lp' "$root/promotion.env" 2>/dev/null || stat -c '%a' "$root/promotion.env")" = 600
test "$(grep -Ec '^MOA_(DEPLOY_REVIEWER|PREVIEW_DEPLOYER|PRODUCTION_PROMOTER)_TOKEN=.{32,}$' "$root/gateway.env")" = 3
test -f "$root/systemd/chief-moa-auto-update.service.d/promotion.conf"
echo "promotion control-plane installer test passed"
