#!/usr/bin/env bash
# Turn one published vps-deploy commit into an isolated preview, M4 evidence,
# guarded apply, receipt, and cleanup. Active persistent volumes are preserved
# in place; promotion does not copy them.

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"
PROMOTION_ENV="${MOA_PROMOTION_ENV_FILE:-$MOA_ROOT/promotion.env}"
[ -f "$PROMOTION_ENV" ] || { echo "promotion deferred: missing $PROMOTION_ENV" >&2; exit 75; }
set -a
# shellcheck disable=SC1090
source "$PROMOTION_ENV"
set +a

REF="${1:-vps-deploy}"
git -C "$APP_DIR" fetch origin "$REF"
target="$(git -C "$APP_DIR" rev-parse "origin/$REF^{commit}")"
current="$(git -C "$APP_DIR" rev-parse HEAD)"
[ "$target" != "$current" ] || exit 0

require_drain() {
  local activity
  activity="$(curl -fsS --max-time 5 "$MOA_CONTROL_PLANE_URL/health")"
  if ! node_runtime -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const activity = JSON.parse(input).voice_stream?.activity ?? {};
      if (activity.drain_safe !== true) process.exit(1);
    });
  ' <<<"$activity"; then
    echo "promotion deferred: gateway is not drained ($activity)" >&2
    return 75
  fi
}
require_drain

suffix="${target:0:12}"
project="moa-preview-$suffix"
preview_port="${MOA_PREVIEW_PORT:-18787}"
preview_tls_port="${MOA_PREVIEW_TLS_PORT:-18789}"
preview_root="$MOA_ROOT/previews/$suffix"
source_dir="$preview_root/source"
preview_env="$preview_root/preview.env"
evidence_dir="${MOA_PROMOTION_EVIDENCE_DIR:-$MOA_ROOT/promotion-evidence}"
evidence_file="$evidence_dir/$target.json"
preview_tls_container="moa-preview-tls-$suffix"

preview_compose() {
  GATEWAY_PORT="$preview_port" GATEWAY_BIND=127.0.0.1 \
    docker compose -p "$project" -f "$source_dir/docker-compose.yml" --env-file "$preview_env" "$@"
}
cleanup() {
  docker rm -f "$preview_tls_container" >/dev/null 2>&1 || true
  preview_compose down -v >/dev/null 2>&1 || true
  git -C "$APP_DIR" worktree remove --force "$source_dir" >/dev/null 2>&1 || true
}
trap cleanup EXIT
mkdir -p "$preview_root" "$evidence_dir"
preview_compose down -v >/dev/null 2>&1 || true
docker rm -f "$preview_tls_container" >/dev/null 2>&1 || true
git -C "$APP_DIR" worktree remove --force "$source_dir" >/dev/null 2>&1 || true
git -C "$APP_DIR" worktree add --detach "$source_dir" "$target" >/dev/null
"$source_dir/scripts/vps/install-release-control-database-credentials.sh" --check

preview_token="$(openssl rand -hex 32)"
preview_password="$(openssl rand -hex 32)"
preview_release_password="$(openssl rand -hex 32)"
preview_release_publisher_password="$(openssl rand -hex 32)"
cat > "$preview_env" <<ENV
MOA_MODE=self-host
MOA_GATEWAY_TOKEN=$preview_token
POSTGRES_PASSWORD=$preview_password
RELEASE_CONTROL_POSTGRES_PASSWORD=$preview_release_password
RELEASE_CONTROL_PUBLISHER_POSTGRES_PASSWORD=$preview_release_publisher_password
GATEWAY_IMAGE_TAG=preview-$suffix
GATEWAY_BIND=127.0.0.1
GATEWAY_PORT=$preview_port
PUBLIC_GATEWAY_URL=http://127.0.0.1:$preview_port
MODEL_PROVIDER=openai-compatible
MODEL_BASE_URL=http://127.0.0.1/preview-no-provider
MODEL_ID=preview-no-provider
VOICE_PROVIDER=loopback
VOICE_STT_PROVIDER=loopback
VOICE_LLM_PROVIDER=loopback
VOICE_TTS_PROVIDER=loopback
ENV
chmod 600 "$preview_env"

# Prove the candidate builds and boots before any active mutation.
MOA_BUILD_SHA="$target" MOA_BUILD_REF="$REF" MOA_BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  preview_compose up -d --build --wait
preview_upstream_url="http://127.0.0.1:$preview_port"
preview_url="https://127.0.0.1:$preview_tls_port"
curl -fsS --max-time 5 "$preview_upstream_url/health" >/dev/null
start_preview_tls_proxy "$preview_tls_container" "$preview_tls_port" "$preview_upstream_url"
wait_for_preview_tls() {
  local attempt
  for attempt in $(seq 1 30); do
    curl -kfsS --max-time 3 "$preview_url/health" >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "promotion blocked: TLS preview did not become healthy at $preview_url" >&2
  return 1
}
wait_for_preview_tls
unauthorized="$(curl -ksS -o /dev/null -w '%{http_code}' --max-time 5 "$preview_url/v1/supervisor/status")"
[ "$unauthorized" = "401" ] || { echo "promotion blocked: preview auth gate returned $unauthorized" >&2; exit 1; }
curl -kfsS --max-time 5 -H "Authorization: Bearer $preview_token" "$preview_url/v1/supervisor/status" >/dev/null

# Recheck immediately before minting apply authority. update.sh checks again
# immediately before checkout mutation.
require_drain
database_ref="verification://database/${project}-postgres-volume"
queue_ref="verification://queue/${project}-disabled-isolated"
storage_ref="verification://storage/${project}-gateway-volume"
worker_ref="verification://worker-pool/${project}-disabled-isolated"
drain_ref="verification://drain/active-drain-safe"
compatibility_ref="compatibility://additive-state-contract/$suffix"
state_preservation_ref="state://persistent-volumes-preserved/$suffix"
rollback_ref="rollback://git/$current"
post_smoke_ref="smoke://active/health"
node_runtime "$source_dir/scripts/vps/create-promotion-evidence.js" \
  --commit "$target" --control-plane-url "$MOA_CONTROL_PLANE_URL" --output "$evidence_file" \
  --preview-url "$preview_url" --active-url "$MOA_ACTIVE_URL" \
  --database-ref "$database_ref" --queue-ref "$queue_ref" --storage-ref "$storage_ref" \
  --worker-pool-ref "$worker_ref" --drain-resume-ref "$drain_ref" \
  --compatibility-ref "$compatibility_ref" \
  --backup-restore-ref "$state_preservation_ref" --rollback-ref "$rollback_ref" \
  --post-apply-smoke-ref "$post_smoke_ref"

MOA_PROMOTION_EVIDENCE_FILE="$evidence_file" "$SCRIPT_DIR/update.sh" \
  --ref "$REF" --commit "$target" --evidence "$evidence_file"
trap - EXIT
cleanup
echo "promotion complete: $current -> $target"
