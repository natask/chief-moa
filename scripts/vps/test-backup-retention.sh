#!/usr/bin/env bash
# Backup retention and promotion-backup reuse.
#
# Two properties protect the user's data here, and both were broken:
#
#   1. A promotion must not consume the scheduled retention window. Every
#      promotion attempt wrote ~1.3 GB and pruned the oldest of 14; 66 prune
#      events in five days left a 14-deep window holding about five hours of
#      history.
#   2. A promotion must not pay for a backup twice. promote-candidate.sh took
#      one and update.sh immediately took another.
#
# These cases run backup.sh and update.sh's reuse gate against stubs, so they
# assert the retention arithmetic and the reuse preconditions without needing
# Docker or a real 1.3 GB archive.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT

FAILURES=0
check() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    printf 'ok   %s\n' "$label"
  else
    printf 'FAIL %s\n     expected: %s\n     actual:   %s\n' "$label" "$expected" "$actual"
    FAILURES=$((FAILURES + 1))
  fi
}

# --- harness -----------------------------------------------------------------
# backup.sh's only real dependencies are compose (pg_dump / tar) and the env
# file. Stub both, so the script's own manifest and prune logic are what runs.
new_env() {
  local case_dir="$1"
  mkdir -p "$case_dir/scripts" "$case_dir/app" "$case_dir/backups"
  cp "$SCRIPT_DIR/backup.sh" "$case_dir/scripts/backup.sh"
  printf 'GATEWAY_PORT=8787\nMOA_DOMAIN=example.test\n' >"$case_dir/env"
  cat >"$case_dir/scripts/lib.sh" <<'EOF'
APP_DIR="${APP_DIR:?}"; ENV_FILE="${ENV_FILE:?}"; BACKUP_DIR="${BACKUP_DIR:?}"
COMPOSE_PROJECT=test
require_env_file() { test -f "$ENV_FILE"; }
env_value() { sed -n "s/^${1}=//p" "$ENV_FILE" | tail -n 1; }
compose() {
  case "$*" in
    *pg_dump*moa_release_control*) printf -- '-- release control dump\n' ;;
    *pg_dump*) printf -- '-- gateway dump\n' ;;
    *"select 1 from pg_database"*) printf '1\n' ;;
    *tar*) printf 'fake-archive\n' ;;
  esac
}
EOF
}

run_backup() {
  local case_dir="$1" reason="${2:-}"
  ( cd "$case_dir/app" \
    && APP_DIR="$case_dir/app" ENV_FILE="$case_dir/env" BACKUP_DIR="$case_dir/backups" \
       MOA_BACKUP_REASON="$reason" \
       MOA_BACKUP_RETENTION="${MOA_BACKUP_RETENTION:-3}" \
       MOA_PROMOTION_BACKUP_RETENTION="${MOA_PROMOTION_BACKUP_RETENTION:-2}" \
       bash "$case_dir/scripts/backup.sh" ) >>"$case_dir/out" 2>&1
  # Timestamps are whole seconds; keep each backup in its own second so the
  # chronological prune order is unambiguous.
  sleep 1
}

# Counts only complete backups, matching what the prune itself counts. An
# incomplete backup is deliberately outside the retention arithmetic.
count_reason() {
  local case_dir="$1" reason="$2" n=0 dir
  for dir in "$case_dir"/backups/*/; do
    [ -d "$dir" ] || continue
    [ -f "$dir/postgres-dump.sql" ] && [ -f "$dir/data-dir.tar.gz" ] || continue
    if grep -qx "reason=$reason" "$dir/manifest.txt" 2>/dev/null; then n=$((n + 1)); fi
  done
  printf '%s\n' "$n"
}

# --- case 1: promotion churn cannot evict scheduled history ------------------
case1="$ROOT/churn"
new_env "$case1"
MOA_BACKUP_RETENTION=3 MOA_PROMOTION_BACKUP_RETENTION=2
for _ in 1 2 3; do run_backup "$case1" scheduled; done
check "three scheduled backups are kept" "3" "$(count_reason "$case1" scheduled)"

# A day of failed promotions, each taking a backup.
for _ in 1 2 3 4 5 6; do run_backup "$case1" promotion; done
check "scheduled history survives promotion churn" "3" "$(count_reason "$case1" scheduled)"
check "promotion backups prune to their own retention" "2" "$(count_reason "$case1" promotion)"

# --- case 2: scheduled backups still prune among themselves ------------------
case2="$ROOT/scheduled"
new_env "$case2"
for _ in 1 2 3 4 5; do run_backup "$case2" scheduled; done
check "scheduled retention is still enforced" "3" "$(count_reason "$case2" scheduled)"

# --- case 3: an untagged legacy backup counts as scheduled -------------------
case3="$ROOT/legacy"
new_env "$case3"
legacy="$case3/backups/20200101T000000Z"
mkdir -p "$legacy"
printf 'x\n' >"$legacy/postgres-dump.sql"
printf 'x\n' >"$legacy/data-dir.tar.gz"
printf 'created_utc=20200101T000000Z\n' >"$legacy/manifest.txt"
run_backup "$case3" promotion
check "a promotion never prunes an untagged legacy backup" "yes" \
  "$([ -d "$legacy" ] && echo yes || echo no)"

# --- case 4: an incomplete backup is neither counted nor deleted -------------
case4="$ROOT/incomplete"
new_env "$case4"
broken="$case4/backups/20200102T000000Z"
mkdir -p "$broken"
: >"$broken/postgres-dump.sql"   # 0-byte dump, no archive: unrestorable
printf 'created_utc=20200102T000000Z\nreason=scheduled\n' >"$broken/manifest.txt"
for _ in 1 2 3 4; do run_backup "$case4" scheduled; done
check "an incomplete backup is not deleted" "yes" "$([ -d "$broken" ] && echo yes || echo no)"
check "an incomplete backup does not displace good ones" "3" "$(count_reason "$case4" scheduled)"
check "an incomplete backup is reported, not hidden" "yes" \
  "$(grep -q 'Skipping incomplete backup' "$case4/out" && echo yes || echo no)"

# --- case 5: the manifest records the reason --------------------------------
case5="$ROOT/manifest"
new_env "$case5"
run_backup "$case5" promotion
check "the manifest carries the reason" "reason=promotion" \
  "$(grep -h '^reason=' "$case5"/backups/*/manifest.txt | head -n 1)"

# --- case 6: an invalid reason is refused ------------------------------------
case6="$ROOT/badreason"
new_env "$case6"
set +e
( APP_DIR="$case6/app" ENV_FILE="$case6/env" BACKUP_DIR="$case6/backups" \
  MOA_BACKUP_REASON=whatever bash "$case6/scripts/backup.sh" ) >/dev/null 2>&1
check "an unknown backup reason is refused" "64" "$?"
set -e

# --- case 7: the reuse gate ---------------------------------------------------
# update.sh reuses a backup only when it is complete, restore-verified against
# THIS candidate, and recent. Exercise the predicate directly.
candidate="$(printf '%040d' 0 | tr 0 c)"
other="$(printf '%040d' 0 | tr 0 a)"
gate="$ROOT/gate"
mkdir -p "$gate"
# Extract the predicate from update.sh so the test cannot drift from the shipped
# implementation.
sed -n '/^reusable_backup() {/,/^}/p' "$SCRIPT_DIR/update.sh" >"$gate/predicate.sh"
[ -s "$gate/predicate.sh" ] || { echo "FAIL could not extract reusable_backup from update.sh"; exit 1; }

make_backup() {
  local dir="$1" commit="$2" checked_at="$3" complete="${4:-yes}"
  mkdir -p "$dir"
  printf 'x\n' >"$dir/postgres-dump.sql"
  [ "$complete" = yes ] && printf 'x\n' >"$dir/data-dir.tar.gz"
  [ -n "$commit" ] && cat >"$dir/restore-check.json" <<RECEIPT
{
  "schema_version": 1,
  "checked_at": "$checked_at",
  "verified_commit": "$commit",
  "nodes": 1,
  "release_assignments": 0
}
RECEIPT
  return 0
}

try_reuse() {
  local dir="$1"
  ( set +e
    candidate_sha="$candidate"
    BACKUP_MAX_AGE=3600
    # shellcheck disable=SC1090
    source "$gate/predicate.sh"
    reusable_backup "$dir" >/dev/null 2>&1
    echo $? )
}

now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
stale="$(date -u -d '2 hours ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
  || date -u -v-2H +%Y-%m-%dT%H:%M:%SZ)"

make_backup "$gate/good" "$candidate" "$now"
check "a fresh backup verified against the candidate is reused" "0" "$(try_reuse "$gate/good")"

make_backup "$gate/wrong-commit" "$other" "$now"
check "a backup verified against another commit is refused" "1" "$(try_reuse "$gate/wrong-commit")"

make_backup "$gate/stale" "$candidate" "$stale"
check "a stale restore proof is refused" "1" "$(try_reuse "$gate/stale")"

make_backup "$gate/no-receipt" "" "$now"
check "a backup with no restore receipt is refused" "1" "$(try_reuse "$gate/no-receipt")"

make_backup "$gate/incomplete" "$candidate" "$now" no
check "an incomplete backup is refused" "1" "$(try_reuse "$gate/incomplete")"

check "a missing directory is refused" "1" "$(try_reuse "$gate/does-not-exist")"

if [ "$FAILURES" -eq 0 ]; then
  echo "backup retention and promotion-reuse tests passed"
else
  echo "$FAILURES check(s) failed" >&2
  exit 1
fi
