#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT

run_case() {
  local failure="$1" expected="$2"
  local case_dir="$ROOT/$failure"
  mkdir -p "$case_dir/scripts" "$case_dir/app" "$case_dir/backups" "$case_dir/bin"
  cp "$SCRIPT_DIR/update.sh" "$case_dir/scripts/update.sh"
  cp "$SCRIPT_DIR/recover-promotion.sh" "$case_dir/scripts/recover-promotion.sh"
  : >"$case_dir/env"
  printf 'GATEWAY_PORT=8787\nMOA_DOMAIN=example.test\n' >"$case_dir/env"
  printf '%040d\n' 0 | tr 0 a >"$case_dir/current"
  printf '{}\n' >"$case_dir/evidence.json"
  if [ "$failure" = effect-rejected ]; then printf 'previous\n' >"$case_dir/receipt.json"; fi

  cat >"$case_dir/scripts/lib.sh" <<'EOF'
APP_DIR="${APP_DIR:?}"; ENV_FILE="${ENV_FILE:?}"; BACKUP_DIR="${BACKUP_DIR:?}"
require_env_file() { test -f "$ENV_FILE"; }
env_value() { sed -n "s/^${1}=//p" "$ENV_FILE" | tail -n 1; }
compose() {
  printf 'compose %s current=%s\n' "$*" "$(cat "$TEST_STATE/current")" >>"$TEST_STATE/log"
  case "$*:$TEST_FAILURE:$(cat "$TEST_STATE/current")" in
    "build gateway:build:"cccccccccccccccccccccccccccccccccccccccc) return 42 ;;
    "up -d --no-deps gateway:up:"cccccccccccccccccccccccccccccccccccccccc) return 43 ;;
    "build gateway:rollback:"*) return 44 ;;
    "ps -q caddy:"*) printf 'fake-caddy\n' ;;
  esac
}
wait_for_gateway_health() {
  printf 'health current=%s\n' "$(cat "$TEST_STATE/current")" >>"$TEST_STATE/log"
  if [ "$TEST_FAILURE" = health ] && grep -q '^c' "$TEST_STATE/current"; then return 45; fi
}
EOF
  cat >"$case_dir/scripts/backup.sh" <<'EOF'
#!/usr/bin/env bash
mkdir -p "$BACKUP_DIR/backup-1"
EOF
  cat >"$case_dir/scripts/restore-check.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  chmod +x "$case_dir/scripts/"*.sh

  cat >"$case_dir/bin/git" <<'EOF'
#!/usr/bin/env bash
args="$*"
case "$args" in
  *fetch\ origin) exit 0 ;;
  *"rev-parse origin/master^{commit}"*) printf '%040d\n' 0 | tr 0 c ;;
  *"rev-parse HEAD"*) cat "$TEST_STATE/current" ;;
  *"rev-parse --short HEAD"*) cut -c1-12 "$TEST_STATE/current" ;;
  *"checkout --force --detach origin/master"*)
    printf '%040d\n' 0 | tr 0 c >"$TEST_STATE/current"
    [ "$TEST_FAILURE" != checkout ] || exit 41 ;;
  *"checkout --force --detach master"*) exit 41 ;;
  *"checkout --force --detach aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"*)
    [ "$TEST_FAILURE" != rollback ] || exit 46
    printf '%040d\n' 0 | tr 0 a >"$TEST_STATE/current" ;;
  *"diff --quiet"*) exit 1 ;;
  *) echo "unexpected git: $args" >&2; exit 90 ;;
esac
EOF
  cat >"$case_dir/bin/node" <<'EOF'
#!/usr/bin/env bash
[ "${1:-}" != -e ] || { cat >/dev/null; exit 0; }
name="$(basename "$1")"
if [ "$name" = validate-promotion-evidence.js ]; then
  count="$(cat "$TEST_STATE/validate-count" 2>/dev/null || echo 0)"; count=$((count + 1)); echo "$count" >"$TEST_STATE/validate-count"
  [ "$TEST_FAILURE" != evidence ] || [ "$count" -ne 2 ] || exit 47
  exit 0
fi
if [ "$name" = record-promotion-receipt.js ]; then
  receipt=""; journal=""; recover=0; shift
  while [ $# -gt 0 ]; do
    [ "$1" != --receipt ] || receipt="$2"
    [ "$1" != --journal ] || journal="$2"
    [ "$1" != --recover ] || recover=1
    shift
  done
  if [ "$recover" = 1 ]; then
    receipt="$(sed -n 's/.*"receipt": "\([^"]*\)".*/\1/p' "$journal")"
    printf 'candidate\n' >"$receipt"; printf 'receipted\n' >"$TEST_STATE/m4"; rm -f "$journal"; exit 0
  fi
  printf '{"phase": "effect_attempting", "receipt": "%s"}\n' "$receipt" >"$journal"
  if [ "$TEST_FAILURE" = effect-rejected ]; then
    printf '{"phase": "effect_rejected", "receipt": "%s"}\n' "$receipt" >"$journal"; exit 48
  fi
  printf 'effect\n' >"$TEST_STATE/m4"
  [ "$TEST_FAILURE" != m4-effect ] || exit 48
  printf '{"phase": "effect_observed", "receipt": "%s"}\n' "$receipt" >"$journal"
  printf '{"phase": "receipt_attempting", "receipt": "%s"}\n' "$receipt" >"$journal"
  printf 'receipted\n' >"$TEST_STATE/m4"
  [ "$TEST_FAILURE" != m4-receipt ] || exit 49
  printf '{"phase": "receipt_observed", "receipt": "%s"}\n' "$receipt" >"$journal"
  printf '{"phase": "mirror_attempting", "receipt": "%s"}\n' "$receipt" >"$journal"
  [ -z "$receipt" ] || { mkdir -p "$(dirname "$receipt")"; printf 'candidate\n' >"$receipt"; }
  [ "$TEST_FAILURE" != receipt-mirror ] || exit 50
  rm -f "$journal"
  exit 0
fi
exit 91
EOF
  cat >"$case_dir/bin/curl" <<'EOF'
#!/usr/bin/env bash
printf '{"voice_stream":{"activity":{"drain_safe":true}}}\n'
EOF
  cat >"$case_dir/bin/docker" <<'EOF'
#!/usr/bin/env bash
printf 'docker %s current=%s\n' "$*" "$(cat "$TEST_STATE/current")" >>"$TEST_STATE/log"
if grep -q '^c' "$TEST_STATE/current"; then
  if [ "$TEST_FAILURE" = caddy-validate ] && [ "$4" = validate ]; then exit 49; fi
  if [ "$TEST_FAILURE" = caddy-reload ] && [ "$4" = reload ]; then exit 50; fi
fi
exit 0
EOF
  chmod +x "$case_dir/bin/"*

  set +e
  PATH="$case_dir/bin:$PATH" TEST_STATE="$case_dir" TEST_FAILURE="$failure" \
    APP_DIR="$case_dir/app" ENV_FILE="$case_dir/env" BACKUP_DIR="$case_dir/backups" \
    MOA_PROMOTION_RECEIPT_FILE="$case_dir/receipt.json" MOA_PROMOTION_JOURNAL_FILE="$case_dir/journal.json" \
    bash "$case_dir/scripts/update.sh" --ref master --evidence "$case_dir/evidence.json" \
    >"$case_dir/stdout" 2>"$case_dir/stderr"
  status=$?
  set -e

  if [ "$expected" = success ]; then
    [ "$status" -eq 0 ]
    grep -q '^c' "$case_dir/current"
    test -f "$case_dir/receipt.json"
    ! grep -q 'Rolling gateway back' "$case_dir/stderr"
  else
    [ "$status" -ne 0 ]
    case "$failure" in
      checkout) [ "$status" -eq 41 ] ;;
      build) [ "$status" -eq 42 ] ;;
      evidence) [ "$status" -eq 47 ] ;;
      up) [ "$status" -eq 43 ] ;;
      health|caddy-validate|caddy-reload) [ "$status" -eq 1 ] ;;
      effect-rejected|m4-effect) [ "$status" -eq 48 ] ;;
      m4-receipt) [ "$status" -eq 49 ] ;;
      receipt-mirror) [ "$status" -eq 50 ] ;;
      rollback) [ "$status" -eq 44 ] ;;
    esac
    if [ "$failure" = effect-rejected ]; then
      grep -qx previous "$case_dir/receipt.json"
    elif [ "$failure" != m4-effect ] && [ "$failure" != m4-receipt ] && [ "$failure" != receipt-mirror ]; then
      test ! -e "$case_dir/receipt.json"
    fi
    if [ "$failure" = m4-effect ] || [ "$failure" = m4-receipt ] || [ "$failure" = receipt-mirror ]; then
      grep -q '^c' "$case_dir/current"
      grep -q '^effect\|^receipted' "$case_dir/m4"
      test -f "$case_dir/journal.json"
      ! grep -q 'Rolling gateway back' "$case_dir/stderr"
      grep -q 'PROMOTION RECOVERY REQUIRED' "$case_dir/stderr"
      before="$(wc -l <"$case_dir/log")"
      PATH="$case_dir/bin:$PATH" TEST_STATE="$case_dir" TEST_FAILURE=recovery \
        bash "$case_dir/scripts/recover-promotion.sh" --journal "$case_dir/journal.json"
      [ "$(wc -l <"$case_dir/log")" -eq "$before" ]
      grep -qx receipted "$case_dir/m4"
      grep -qx candidate "$case_dir/receipt.json"
      test ! -e "$case_dir/journal.json"
    elif [ "$failure" = rollback ]; then
      grep -q 'Rolling gateway back' "$case_dir/stderr"
      grep -q 'ROLLBACK FAILED' "$case_dir/stderr"
      grep -q 'rollback also failed' "$case_dir/stderr"
    else
      grep -q 'Rolling gateway back' "$case_dir/stderr"
      grep -q '^a' "$case_dir/current"
      grep -q 'candidate apply remains failed and unreceipted' "$case_dir/stderr"
      test ! -e "$case_dir/m4"
    fi
  fi
}

for failure in checkout build evidence up health caddy-validate caddy-reload effect-rejected m4-effect m4-receipt receipt-mirror rollback; do
  run_case "$failure" failure
done
run_case success success
echo "promotion rollback/recovery adversarial tests passed (13 cases)"
