#!/usr/bin/env bash
# Update the running VPS gateway to a new git ref while preserving the event
# store. Only the gateway service is rebuilt and recreated: Postgres and Caddy keep
# running, and the named data volumes are untouched. Schema changes apply on
# gateway boot (schema.sql is idempotent).
#
#   scripts/vps/update.sh                # update to origin/master
#   scripts/vps/update.sh --ref my-branch
# Promotion does not copy persistent state. Rollback restores the prior code
# while leaving the same volumes mounted, so active changes must remain additive
# and backward-compatible.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

REF="${MOA_REF:-master}"
EVIDENCE_FILE="${MOA_PROMOTION_EVIDENCE_FILE:-}"
EXPECTED_COMMIT="${MOA_EXPECTED_COMMIT:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="$2"; shift 2 ;;
    --commit) EXPECTED_COMMIT="$2"; shift 2 ;;
    --evidence) EVIDENCE_FILE="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

require_env_file
cd "$APP_DIR"

# Failures before a remote M4 effect can be accepted restore the old artifact.
# Once an effect request is in flight, the durable journal forces forward
# recovery: blindly rolling back would contradict immutable control-plane
# state if the effect was accepted just before a crash or network failure.
promotion_mutated=0
promotion_complete=0
rollback_running=0
receipt_file="${MOA_PROMOTION_RECEIPT_FILE:-$APP_DIR/.deploy-markers/gateway-promotion-receipt.json}"
promotion_journal="${MOA_PROMOTION_JOURNAL_FILE:-$APP_DIR/.deploy-markers/gateway-promotion-journal.json}"
receipt_backup=""

rollback_gateway() {
  local rollback_failed=0 caddy_container=""
  echo "Rolling gateway back to $old_full_sha" >&2
  git -C "$APP_DIR" checkout --force --detach "$old_full_sha" || rollback_failed=1
  compose build gateway || rollback_failed=1
  compose up -d --no-deps gateway || rollback_failed=1
  if [ -n "${port:-}" ]; then
    wait_for_gateway_health "http://127.0.0.1:$port/health" 45 || rollback_failed=1
  fi
  # A later receipt failure can happen after a candidate Caddy reload. Restore
  # the old checkout's edge configuration as part of the same rollback.
  if [ "${caddy_changed:-0}" = "1" ]; then
    caddy_container="$(compose ps -q caddy)" || rollback_failed=1
    if [ -z "$caddy_container" ] \
      || ! docker exec "$caddy_container" caddy validate --config /etc/caddy/Caddyfile \
      || ! docker exec "$caddy_container" caddy reload --config /etc/caddy/Caddyfile; then
      rollback_failed=1
    fi
  fi
  rm -f -- "$receipt_file" || rollback_failed=1
  if [ -n "$receipt_backup" ] && [ -f "$receipt_backup" ]; then
    mv -f -- "$receipt_backup" "$receipt_file" || rollback_failed=1
  fi
  if [ "$rollback_failed" -ne 0 ]; then
    echo "ROLLBACK FAILED for $old_full_sha; manual recovery is required; candidate promotion receipt is absent" >&2
    return 1
  fi
  echo "Rollback restored $old_full_sha; candidate apply remains failed and unreceipted" >&2
}

promotion_exit() {
  local original_status=$? rollback_status=0 phase=""
  trap - EXIT
  if [ "$original_status" -eq 0 ] || [ "$promotion_complete" -eq 1 ] \
    || [ "$promotion_mutated" -eq 0 ] || [ "$rollback_running" -eq 1 ]; then
    [ -z "$receipt_backup" ] || rm -f -- "$receipt_backup"
    exit "$original_status"
  fi
  if [ -f "$promotion_journal" ]; then
    phase="$(sed -n 's/.*"phase": "\([^"]*\)".*/\1/p' "$promotion_journal" | head -n 1)"
  fi
  case "$phase" in
    effect_attempting|effect_observed|receipt_attempting|receipt_observed|mirror_attempting)
      echo "PROMOTION RECOVERY REQUIRED: candidate remains active because M4 effect may be immutable (journal phase: $phase)" >&2
      echo "Run: $SCRIPT_DIR/recover-promotion.sh --journal $promotion_journal" >&2
      exit "$original_status"
      ;;
  esac
  rollback_running=1
  set +e
  rollback_gateway
  rollback_status=$?
  if [ "$rollback_status" -ne 0 ]; then
    echo "Promotion failed with status $original_status and rollback also failed" >&2
  fi
  exit "$original_status"
}
trap promotion_exit EXIT

# Resolve and validate the exact candidate before any active mutation. The
# manifest is produced only after the M4 request/review/preview/verification/
# claim chain and records isolated preview, drain/resume, compatibility and
# rollback evidence. Merely having a green CI run is not promotion authority.
git -C "$APP_DIR" fetch origin
if [ -n "$EXPECTED_COMMIT" ]; then
  [[ "$EXPECTED_COMMIT" =~ ^[a-f0-9]{40}$ ]] || { echo "--commit must be a full lowercase Git SHA" >&2; exit 64; }
  candidate_sha="$(git -C "$APP_DIR" rev-parse "$EXPECTED_COMMIT^{commit}")"
  [ "$candidate_sha" = "$EXPECTED_COMMIT" ] || { echo "Pinned candidate did not resolve exactly" >&2; exit 65; }
  verified_ref_sha="$(git -C "$APP_DIR" rev-parse "origin/$REF^{commit}" 2>/dev/null \
    || git -C "$APP_DIR" rev-parse "$REF^{commit}")"
  git -C "$APP_DIR" merge-base --is-ancestor "$candidate_sha" "$verified_ref_sha" || {
    echo "Pinned candidate is not in the current verified $REF history" >&2
    exit 65
  }
else
  candidate_sha="$(git -C "$APP_DIR" rev-parse "origin/$REF^{commit}" 2>/dev/null \
    || git -C "$APP_DIR" rev-parse "$REF^{commit}")"
fi
[ -n "$EVIDENCE_FILE" ] || {
  echo "MOA_PROMOTION_EVIDENCE_FILE or --evidence is required" >&2
  exit 65
}
node_runtime "$SCRIPT_DIR/validate-promotion-evidence.js" \
  --file "$EVIDENCE_FILE" --commit "$candidate_sha" --target gateway \
  --control-plane-url "${MOA_CONTROL_PLANE_URL:-}"

# A user turn may start while preview/evidence work runs. Recheck at the last point
# before checkout mutation; M4 evidence is necessary but cannot replace live
# no-interruption evidence.
port="$(env_value GATEWAY_PORT)"
port="${port:-8787}"
if ! curl -fsS --max-time 5 "http://127.0.0.1:$port/health" | node_runtime -e '
  let input = "";
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    if (JSON.parse(input).voice_stream?.activity?.drain_safe !== true) process.exit(1);
  });
'; then
  echo "Promotion deferred: active gateway is no longer drain-safe." >&2
  exit 75
fi

# 2. Move the checkout to the requested ref. This checkout is a deploy
# artifact, never a workspace (fix work happens in branches elsewhere), so
# --force discarding stray local files is the wanted behavior: without it a
# single untracked file that the new ref tracks wedges every update.
old_full_sha="$(git -C "$APP_DIR" rev-parse HEAD)"
old_sha="${old_full_sha:0:12}"
# Preserve the prior immutable receipt so a failed candidate cannot erase the
# last known-good deployment record while ensuring its own receipt is absent.
if [ -f "$receipt_file" ]; then
  receipt_backup="${receipt_file}.pre-promotion.$$"
  cp -p -- "$receipt_file" "$receipt_backup"
fi
promotion_mutated=1
git -C "$APP_DIR" checkout --force --detach "$candidate_sha"
new_sha="$(git -C "$APP_DIR" rev-parse --short HEAD)"

# 3. Rebuild and recreate only the gateway. Volumes and other services stay.
# The guarded updater normally uses --no-deps for the active gateway, so run
# the candidate's one-shot additive release-control migration explicitly first.
# This occurs after preview/evidence proof and before the active gateway effect.
compose run --rm --no-deps release-control-db-init
MOA_BUILD_SHA="$(git -C "$APP_DIR" rev-parse HEAD)" \
MOA_BUILD_REF="$REF" \
MOA_BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  compose build gateway
# Backup/restore and build can outlive a lease. Recheck M4 immediately before
# the first active effect while the old gateway/control plane is still alive.
node_runtime "$SCRIPT_DIR/validate-promotion-evidence.js" \
  --file "$EVIDENCE_FILE" --commit "$candidate_sha" --target gateway \
  --control-plane-url "${MOA_CONTROL_PLANE_URL:-}"
compose up -d --no-deps gateway

if ! wait_for_gateway_health "http://127.0.0.1:$port/health" 45; then
  echo "Post-apply smoke failed" >&2
  exit 1
fi

# 4. If the Caddyfile changed in this update, apply it with a validated
# graceful reload. Requires the directory mount (docker-compose.vps.yml);
# reload keeps the old config on validation failure, so the front never
# drops. An edge-config failure rolls the candidate gateway back and cannot be
# receipted as a successful apply.
caddy_changed=0
if ! git -C "$APP_DIR" diff --quiet "$old_sha" "$new_sha" -- gateway/deploy/vps/Caddyfile; then
  caddy_changed=1
  caddy_container="$(compose ps -q caddy)"
  if [ -z "$caddy_container" ] \
    || ! docker exec "$caddy_container" caddy validate --config /etc/caddy/Caddyfile \
    || ! docker exec "$caddy_container" caddy reload --config /etc/caddy/Caddyfile; then
    echo "Caddy candidate validation/reload failed" >&2
    exit 1
  fi
  echo "Caddyfile changed: validated and reloaded caddy."
fi

# 5. Only after the complete edge-visible smoke succeeds, record the M4
# observed effect and immutable receipt, then write the local receipt mirror.
node_runtime "$SCRIPT_DIR/record-promotion-receipt.js" \
  --evidence "$EVIDENCE_FILE" --commit "$candidate_sha" --previous "$old_full_sha" \
  --receipt "$receipt_file" --receipt-backup "$receipt_backup" --journal "$promotion_journal" \
  --health-url "http://127.0.0.1:$port/health" \
  --control-plane-url "${MOA_CONTROL_PLANE_URL:-}"
promotion_complete=1
trap - EXIT
[ -z "$receipt_backup" ] || rm -f -- "$receipt_backup"

domain="$(env_value MOA_DOMAIN)"
echo "Updated gateway $old_sha -> $new_sha"
echo "Health: https://$domain/health"
