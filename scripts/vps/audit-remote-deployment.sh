#!/usr/bin/env bash
# Read-only diagnosis for the pull-based VPS deployment worker.
#
# This script deliberately does not source or print gateway.env/promotion.env,
# invoke the updater, restart a unit, fetch into the checkout, or inspect user
# data. It emits only deployment identifiers and systemd/health summaries.

set -u

APP_DIR="${MOA_VPS_APP_DIR:-/opt/chief-moa/app}"
MOA_ROOT="${MOA_ROOT:-/opt/chief-moa}"
PROMOTION_ENV="${MOA_PROMOTION_ENV_FILE:-$MOA_ROOT/promotion.env}"
TIMER_UNIT="chief-moa-auto-update.timer"
SERVICE_UNIT="chief-moa-auto-update.service"
HEALTH_URL="${MOA_LOCAL_HEALTH_URL:-http://127.0.0.1:8787/health}"

emit() {
  printf '%s=%s\n' "$1" "$2"
}

safe_sha() {
  local value="${1:-}"
  if [[ "$value" =~ ^[0-9a-f]{40}$ ]]; then
    printf '%s' "$value"
  else
    printf 'unknown'
  fi
}

unit_property() {
  systemctl show "$1" --property="$2" --value 2>/dev/null | head -n 1
}

emit audit_schema "chief-moa-vps-audit/v1"
emit audit_mode "read_only"
emit app_dir "$APP_DIR"
emit checked_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

current_sha=""
target_sha=""
origin_status="unreachable"
if [ -d "$APP_DIR/.git" ] || git -C "$APP_DIR" rev-parse --git-dir >/dev/null 2>&1; then
  current_sha="$(git -C "$APP_DIR" rev-parse HEAD 2>/dev/null || true)"
  target_sha="$(git -C "$APP_DIR" ls-remote origin refs/heads/vps-deploy 2>/dev/null | awk 'NR == 1 {print $1}')"
  if [[ "$target_sha" =~ ^[0-9a-f]{40}$ ]]; then
    origin_status="reachable"
  fi
fi
emit deployed_sha "$(safe_sha "$current_sha")"
emit target_sha "$(safe_sha "$target_sha")"
emit origin_status "$origin_status"

timer_enabled="$(systemctl is-enabled "$TIMER_UNIT" 2>/dev/null || true)"
timer_active="$(systemctl is-active "$TIMER_UNIT" 2>/dev/null || true)"
service_active="$(systemctl is-active "$SERVICE_UNIT" 2>/dev/null || true)"
emit timer_enabled "${timer_enabled:-unknown}"
emit timer_active "${timer_active:-unknown}"
emit timer_next "$(unit_property "$TIMER_UNIT" NextElapseUSecRealtime)"
emit timer_last_trigger "$(unit_property "$TIMER_UNIT" LastTriggerUSec)"
emit service_active "${service_active:-unknown}"
emit service_result "$(unit_property "$SERVICE_UNIT" Result)"
emit service_exit_code "$(unit_property "$SERVICE_UNIT" ExecMainCode)"
emit service_exit_status "$(unit_property "$SERVICE_UNIT" ExecMainStatus)"
emit service_last_started "$(unit_property "$SERVICE_UNIT" ExecMainStartTimestamp)"
emit service_last_finished "$(unit_property "$SERVICE_UNIT" ExecMainExitTimestamp)"

if [ -f "$PROMOTION_ENV" ]; then
  emit promotion_env "present"
  emit promotion_env_mode "$(stat -c '%a' "$PROMOTION_ENV" 2>/dev/null || stat -f '%Lp' "$PROMOTION_ENV" 2>/dev/null || printf 'unknown')"
else
  emit promotion_env "missing"
  emit promotion_env_mode "unknown"
fi

promotion_check="unavailable"
promotion_check_output=""
if [ -x "$APP_DIR/scripts/vps/install-promotion-control-plane.sh" ]; then
  if promotion_check_output="$("$APP_DIR/scripts/vps/install-promotion-control-plane.sh" --check 2>&1)"; then
    promotion_check="ready"
  elif [[ "$promotion_check_output" == *"is not configured"* ]]; then
    promotion_check="role_credentials_missing"
  elif [[ "$promotion_check_output" == *"promotion credentials must all be distinct"* ]]; then
    promotion_check="role_credentials_not_distinct"
  elif [[ "$promotion_check_output" == *"gateway env file"* ]]; then
    promotion_check="gateway_env_missing"
  else
    promotion_check="invalid"
  fi
fi
emit promotion_control_plane "$promotion_check"

health_status="unreachable"
health_sha="unknown"
drain_safe="unknown"
health_payload="$(curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null || true)"
if [ -n "$health_payload" ]; then
  health_status="healthy"
  health_sha="$(printf '%s' "$health_payload" | sed -n 's/.*"build":{"git_sha":"\([0-9a-f]\{40\}\)".*/\1/p' | head -n 1)"
  drain_safe="$(printf '%s' "$health_payload" | grep -o '"drain_safe":\(true\|false\)' | head -n 1 | cut -d: -f2)"
fi
emit local_health "$health_status"
emit health_sha "$(safe_sha "$health_sha")"
emit drain_safe "${drain_safe:-unknown}"

journal_class="none"
journal_text="$(journalctl -u "$SERVICE_UNIT" --since=-48h -n 300 --no-pager -o cat 2>/dev/null || true)"
if [[ "$journal_text" == *"missing "*promotion.env* ]]; then
  journal_class="missing_promotion_env"
elif [[ "$journal_text" == *"gateway is not drained"* ]]; then
  journal_class="not_drain_safe"
elif [[ "$journal_text" == *"PROMOTION RECOVERY REQUIRED"* ]]; then
  journal_class="promotion_recovery_required"
elif [[ "$journal_text" == *"restore"*failed* ]] || [[ "$journal_text" == *"Restore"*failed* ]]; then
  journal_class="restore_check_failed"
elif [[ "$journal_text" == *"Backup"*failed* ]] || [[ "$journal_text" == *"backup"*failed* ]]; then
  journal_class="backup_failed"
elif [[ "$journal_text" == *"Could not resolve"* ]] || [[ "$journal_text" == *"Temporary failure in name resolution"* ]]; then
  journal_class="network_resolution_failed"
elif [[ "$journal_text" == *"Permission denied"* ]]; then
  journal_class="permission_denied"
elif [[ "$journal_text" == *"returned HTTP 401"* ]] || [[ "$journal_text" == *"returned HTTP 403"* ]]; then
  journal_class="control_plane_auth_failed"
elif [[ "$journal_text" == *"returned HTTP 404"* ]]; then
  journal_class="control_plane_route_missing"
elif [[ "$journal_text" == *"promotion safely deferred"* ]]; then
  journal_class="promotion_deferred"
elif [[ "$journal_text" == *"promotion complete:"* ]]; then
  journal_class="last_promotion_completed"
fi
emit journal_class "$journal_class"

audit_status="unknown"
blocker="none"
if [[ "$current_sha" =~ ^[0-9a-f]{40}$ ]] && [ "$current_sha" = "$target_sha" ]; then
  audit_status="current"
elif [[ ! "$current_sha" =~ ^[0-9a-f]{40}$ ]]; then
  audit_status="invalid_checkout"
  blocker="checkout_unreadable"
elif [ "$origin_status" != "reachable" ]; then
  audit_status="stale"
  blocker="origin_unreachable"
elif [ "$timer_enabled" != "enabled" ] || [ "$timer_active" != "active" ]; then
  audit_status="stale"
  blocker="timer_inactive"
elif [ ! -f "$PROMOTION_ENV" ]; then
  audit_status="stale"
  blocker="promotion_env_missing"
elif [ "$promotion_check" != "ready" ]; then
  audit_status="stale"
  blocker="promotion_control_plane_$promotion_check"
elif [ "$health_status" != "healthy" ]; then
  audit_status="stale"
  blocker="local_gateway_unhealthy"
elif [ "$drain_safe" != "true" ]; then
  audit_status="stale"
  blocker="gateway_not_drain_safe"
elif [ "$journal_class" != "none" ] && [ "$journal_class" != "last_promotion_completed" ]; then
  audit_status="stale"
  blocker="$journal_class"
elif [ "$(unit_property "$SERVICE_UNIT" Result)" = "failed" ]; then
  audit_status="stale"
  blocker="auto_update_service_failed"
else
  audit_status="stale"
  blocker="worker_did_not_apply_target"
fi
emit audit_status "$audit_status"
emit blocker "$blocker"
