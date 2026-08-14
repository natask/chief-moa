#!/usr/bin/env bash
# Install distinct M4 role credentials and the private environment consumed by
# the pull-based VPS promotion worker. This never prints secret values and does
# not restart or mutate the active gateway container.

set -euo pipefail
umask 077

MOA_ROOT="${MOA_ROOT:-/opt/chief-moa}"
ENV_FILE="${ENV_FILE:-$MOA_ROOT/gateway.env}"
PROMOTION_ENV="${MOA_PROMOTION_ENV_FILE:-$MOA_ROOT/promotion.env}"
SYSTEMD_DIR="${MOA_SYSTEMD_DIR:-/etc/systemd/system}"
MODE="${1:---check}"

[ -f "$ENV_FILE" ] || { echo "Missing gateway env file: $ENV_FILE" >&2; exit 1; }
case "$MODE" in --check|--install) ;; *) echo "Usage: $0 [--check|--install]" >&2; exit 64 ;; esac

value() { sed -n "s/^${1}=//p" "$ENV_FILE" | tail -n 1; }
gateway_token="$(value MOA_GATEWAY_TOKEN)"
[ "${#gateway_token}" -ge 32 ] || { echo "MOA_GATEWAY_TOKEN is missing or too short" >&2; exit 1; }

missing=()
for key in MOA_DEPLOY_REVIEWER_TOKEN MOA_PREVIEW_DEPLOYER_TOKEN \
  MOA_PRODUCTION_PROMOTER_TOKEN MOA_DEVELOPMENT_COORDINATOR_TOKEN; do
  current="$(value "$key")"
  if [ "${#current}" -lt 32 ]; then
    [ "$MODE" = "--install" ] || { echo "$key is not configured" >&2; exit 1; }
    missing+=("$key")
  fi
done
if [ "${#missing[@]}" -gt 0 ]; then
  env_temporary="${ENV_FILE}.$$"
  cp -p "$ENV_FILE" "$env_temporary"
  for key in "${missing[@]}"; do
    printf '%s=%s\n' "$key" "$(openssl rand -hex 32)" >> "$env_temporary"
  done
  mv -f "$env_temporary" "$ENV_FILE"
fi
if [ "$MODE" = "--install" ]; then
  chmod 600 "$ENV_FILE"
  if [ "$(id -u)" -eq 0 ]; then
    chown root:root "$ENV_FILE"
  fi
fi

reviewer="$(value MOA_DEPLOY_REVIEWER_TOKEN)"
preview="$(value MOA_PREVIEW_DEPLOYER_TOKEN)"
promoter="$(value MOA_PRODUCTION_PROMOTER_TOKEN)"
coordinator="$(value MOA_DEVELOPMENT_COORDINATOR_TOKEN)"
tokens=("$gateway_token" "$reviewer" "$preview" "$promoter" "$coordinator")
for ((left = 0; left < ${#tokens[@]}; left++)); do
  for ((right = left + 1; right < ${#tokens[@]}; right++)); do
    [ "${tokens[$left]}" != "${tokens[$right]}" ] \
      || { echo "privileged credentials must all be distinct" >&2; exit 1; }
  done
done

domain="$(value MOA_DOMAIN)"
port="$(value GATEWAY_PORT)"; port="${port:-8787}"
[ -n "$domain" ] || { echo "MOA_DOMAIN is required" >&2; exit 1; }

if [ "$MODE" = "--install" ]; then
  temporary="${PROMOTION_ENV}.$$"
  {
    printf 'MOA_CONTROL_PLANE_URL=http://127.0.0.1:%s\n' "$port"
    printf 'MOA_CONTROL_PLANE_TOKEN=%s\n' "$promoter"
    printf 'MOA_DEPLOY_USER_TOKEN=%s\n' "$gateway_token"
    printf 'MOA_DEPLOY_REVIEWER_TOKEN=%s\n' "$reviewer"
    printf 'MOA_PREVIEW_DEPLOYER_TOKEN=%s\n' "$preview"
    printf 'MOA_PRODUCTION_PROMOTER_TOKEN=%s\n' "$promoter"
    printf 'MOA_PRODUCTION_PROMOTER_ID=production-promoter\n'
    printf 'MOA_PROMOTION_EVIDENCE_DIR=%s/promotion-evidence\n' "$MOA_ROOT"
    printf 'MOA_ACTIVE_URL=https://%s\n' "$domain"
  } > "$temporary"
  chmod 600 "$temporary"
  mv -f "$temporary" "$PROMOTION_ENV"
  if [ "$(id -u)" -eq 0 ]; then
    chown root:root "$PROMOTION_ENV"
  fi
  mkdir -p "$SYSTEMD_DIR/chief-moa-auto-update.service.d"
  drop_in="$SYSTEMD_DIR/chief-moa-auto-update.service.d/promotion.conf"
  printf '[Service]\nEnvironmentFile=%s\n' "$PROMOTION_ENV" > "${drop_in}.$$"
  chmod 600 "${drop_in}.$$"
  mv -f "${drop_in}.$$" "$drop_in"
  if [ "$(id -u)" -eq 0 ]; then
    chown root:root "$drop_in"
  fi
  systemctl daemon-reload
fi

echo "Promotion control-plane configuration is ready; gateway restart is still operator-gated."
