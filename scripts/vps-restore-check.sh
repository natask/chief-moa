#!/usr/bin/env bash
# Scratch-only restore verification for Chief Moa VPS promotion gates.
#
# Canonical live Compose/VPS operations use scripts/vps/restore-check.sh. This
# root entrypoint remains the standalone explicit-input restore verifier from
# the agent-control-plane lane.
#
# This script restores backup artifacts into caller-provided scratch targets and
# starts a local scratch gateway for /health. It does not read .env files or
# touch the active deployment.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

MODE="dry-run"
BACKUP_DIR="${MOA_RESTORE_BACKUP_DIR:-}"
DATABASE_URL="${MOA_RESTORE_DATABASE_URL:-}"
SCRATCH_DIR="${MOA_RESTORE_SCRATCH_DIR:-}"
GATEWAY_PORT="${MOA_RESTORE_GATEWAY_PORT:-}"
CONFIRM_SCRATCH="${MOA_RESTORE_CONFIRM_SCRATCH:-}"
CORE_TABLE="${MOA_RESTORE_CORE_TABLE:-product_events}"
ALLOW_UNLABELED_DATABASE="${MOA_RESTORE_ALLOW_UNLABELED_DATABASE:-0}"
PSQL_BIN="${MOA_RESTORE_PSQL_BIN:-psql}"
TAR_BIN="${MOA_RESTORE_TAR_BIN:-tar}"
GZIP_BIN="${MOA_RESTORE_GZIP_BIN:-gzip}"
CURL_BIN="${MOA_RESTORE_CURL_BIN:-curl}"
NODE_BIN="${MOA_RESTORE_NODE_BIN:-node}"
PG_CONNECT_TIMEOUT="${MOA_RESTORE_PG_CONNECT_TIMEOUT:-10}"

gateway_pid=""

usage() {
  cat <<'USAGE'
Usage:
  scripts/vps-restore-check.sh --dry-run
  scripts/vps-restore-check.sh --execute

Required explicit configuration, via env or matching args:
  MOA_RESTORE_BACKUP_DIR        Backup directory produced by scripts/vps-backup.sh.
  MOA_RESTORE_DATABASE_URL      Empty scratch Postgres URL. Never printed.
  MOA_RESTORE_SCRATCH_DIR       New local scratch directory for restored DATA_DIR/logs.
  MOA_RESTORE_GATEWAY_PORT      Non-active localhost port for scratch /health.
  MOA_RESTORE_CONFIRM_SCRATCH   Must be RESTORE_CHECK_ONLY for --execute.

Optional:
  MOA_RESTORE_CORE_TABLE        Core table checked after restore. Default: product_events.
  MOA_RESTORE_ALLOW_UNLABELED_DATABASE=1
                                  Allows a scratch DB URL without scratch/restore/tmp/test
                                  in the string after manual operator verification.

Args:
  --backup-dir DIR
  --database-url URL            Prefer env so the URL is not stored in shell history.
  --scratch-dir DIR
  --gateway-port PORT
  --confirm-scratch VALUE       Must be RESTORE_CHECK_ONLY for --execute.
  --core-table TABLE
  --dry-run                     Validate and print a sanitized plan. Default.
  --execute                     Restore into scratch targets and run /health.

Safety:
  - The scratch directory must not already exist.
  - The scratch database must be empty before restore.
  - Port 8787 is rejected to avoid colliding with the active gateway default.
  - The gateway is launched with env -i and direct node server.js, not npm start,
    so .env and user credential files are not read.
USAGE
}

log() {
  printf '[vps-restore-check] %s\n' "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

require_arg() {
  local name="$1"
  local value="${2:-}"
  [ -n "$value" ] || die "$name requires a value"
}

cleanup_gateway() {
  if [ -n "$gateway_pid" ] && kill -0 "$gateway_pid" >/dev/null 2>&1; then
    kill "$gateway_pid" >/dev/null 2>&1 || true
    wait "$gateway_pid" 2>/dev/null || true
  fi
}
trap cleanup_gateway EXIT

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      MODE="dry-run"
      shift
      ;;
    --execute)
      MODE="execute"
      shift
      ;;
    --backup-dir)
      require_arg "$1" "${2:-}"
      BACKUP_DIR="$2"
      shift 2
      ;;
    --database-url)
      require_arg "$1" "${2:-}"
      DATABASE_URL="$2"
      shift 2
      ;;
    --scratch-dir)
      require_arg "$1" "${2:-}"
      SCRATCH_DIR="$2"
      shift 2
      ;;
    --gateway-port)
      require_arg "$1" "${2:-}"
      GATEWAY_PORT="$2"
      shift 2
      ;;
    --confirm-scratch)
      require_arg "$1" "${2:-}"
      CONFIRM_SCRATCH="$2"
      shift 2
      ;;
    --core-table)
      require_arg "$1" "${2:-}"
      CORE_TABLE="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "unknown argument: $1"
      ;;
  esac
done

blockers=()

add_blocker() {
  blockers+=("$1")
}

need_command() {
  local label="$1"
  local bin="$2"
  if ! command -v "$bin" >/dev/null 2>&1; then
    add_blocker "missing required command for $label: $bin"
  fi
}

is_integer() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

validate_core_table() {
  if ! [[ "$CORE_TABLE" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    add_blocker "MOA_RESTORE_CORE_TABLE must be a simple public table name"
  fi
}

validate() {
  [ -n "$BACKUP_DIR" ] || add_blocker "MOA_RESTORE_BACKUP_DIR or --backup-dir is required"
  [ -n "$DATABASE_URL" ] || add_blocker "MOA_RESTORE_DATABASE_URL or --database-url is required"
  [ -n "$SCRATCH_DIR" ] || add_blocker "MOA_RESTORE_SCRATCH_DIR or --scratch-dir is required"
  [ -n "$GATEWAY_PORT" ] || add_blocker "MOA_RESTORE_GATEWAY_PORT or --gateway-port is required"
  [ "$CONFIRM_SCRATCH" = "RESTORE_CHECK_ONLY" ] || add_blocker "MOA_RESTORE_CONFIRM_SCRATCH must equal RESTORE_CHECK_ONLY"

  if [ -n "$DATABASE_URL" ] && [ "$ALLOW_UNLABELED_DATABASE" != "1" ]; then
    database_url_lower="$(printf '%s' "$DATABASE_URL" | tr '[:upper:]' '[:lower:]')"
    case "$database_url_lower" in
      *scratch*|*restore*|*tmp*|*test*) ;;
      *) add_blocker "MOA_RESTORE_DATABASE_URL must visibly identify a scratch/restore/tmp/test database, or set MOA_RESTORE_ALLOW_UNLABELED_DATABASE=1 after manual verification" ;;
    esac
  fi

  if [ -n "$BACKUP_DIR" ]; then
    [ -d "$BACKUP_DIR" ] || add_blocker "backup directory does not exist: $BACKUP_DIR"
    [ -f "$BACKUP_DIR/postgres.sql.gz" ] || add_blocker "backup is missing postgres.sql.gz"
    [ -f "$BACKUP_DIR/data-dir.tar.gz" ] || add_blocker "backup is missing data-dir.tar.gz"
    [ -f "$BACKUP_DIR/SHA256SUMS" ] || add_blocker "backup is missing SHA256SUMS"
  fi

  if [ -n "$SCRATCH_DIR" ] && [ -e "$SCRATCH_DIR" ]; then
    add_blocker "scratch directory must not already exist: $SCRATCH_DIR"
  fi

  if [ -n "$GATEWAY_PORT" ]; then
    if ! is_integer "$GATEWAY_PORT"; then
      add_blocker "gateway port must be numeric"
    elif [ "$GATEWAY_PORT" -eq 8787 ]; then
      add_blocker "gateway port 8787 is reserved for active deployments"
    elif [ "$GATEWAY_PORT" -lt 1024 ] || [ "$GATEWAY_PORT" -gt 65535 ]; then
      add_blocker "gateway port must be between 1024 and 65535"
    fi
  fi

  validate_core_table

  need_command "Postgres restore/query" "$PSQL_BIN"
  need_command "tar extraction" "$TAR_BIN"
  need_command "gzip decompression" "$GZIP_BIN"
  need_command "gateway health request" "$CURL_BIN"
  need_command "scratch gateway" "$NODE_BIN"

  [ -f "$ROOT_DIR/gateway/server.js" ] || add_blocker "gateway/server.js is missing"
}

print_blockers() {
  local blocker
  for blocker in "${blockers[@]}"; do
    log "blocker: $blocker"
  done
}

psql_scratch() {
  PGDATABASE="$DATABASE_URL" \
  PGCONNECT_TIMEOUT="$PG_CONNECT_TIMEOUT" \
PGPASSFILE=/dev/null \
PGSERVICEFILE=/dev/null \
    "$PSQL_BIN" --no-password "$@"
}

scratch_table_count() {
  psql_scratch -v ON_ERROR_STOP=1 -tA -c \
    "select count(*) from information_schema.tables where table_schema = 'public';" |
    tr -d '[:space:]'
}

restore_database() {
  "$GZIP_BIN" -dc "$BACKUP_DIR/postgres.sql.gz" |
    psql_scratch -v ON_ERROR_STOP=1 -q
}

check_core_table() {
  local present
  local rows
  present="$(psql_scratch -v ON_ERROR_STOP=1 -tA -c \
    "select case when to_regclass('public.$CORE_TABLE') is null then 'missing' else 'present' end;" |
    tr -d '[:space:]')"
  [ "$present" = "present" ] || die "core table missing after restore: public.$CORE_TABLE"

  rows="$(psql_scratch -v ON_ERROR_STOP=1 -tA -c "select count(*) from public.$CORE_TABLE;" |
    tr -d '[:space:]')"
  log "core query passed: public.$CORE_TABLE rows=$rows"
}

wait_for_health() {
  local health_url="http://127.0.0.1:$GATEWAY_PORT/health"
  local health_file="$SCRATCH_DIR/health.json"
  local attempt

  for attempt in $(seq 1 80); do
    if ! kill -0 "$gateway_pid" >/dev/null 2>&1; then
      die "scratch gateway exited before health was ready; see $SCRATCH_DIR/gateway.log"
    fi
    if "$CURL_BIN" -fsS "$health_url" > "$health_file"; then
      log "scratch gateway health passed: $health_url"
      return 0
    fi
    sleep 0.25
  done

  die "timed out waiting for scratch gateway health; see $SCRATCH_DIR/gateway.log"
}

start_gateway() {
  local scratch_data="$SCRATCH_DIR/data-dir"
  local scratch_home="$SCRATCH_DIR/home"
  local gateway_log="$SCRATCH_DIR/gateway.log"

  mkdir -p "$scratch_home"
  (
    cd "$ROOT_DIR/gateway"
    env -i \
      PATH="$PATH" \
      HOME="$scratch_home" \
      HOST=127.0.0.1 \
      PORT="$GATEWAY_PORT" \
      DATA_DIR="$scratch_data" \
      DATABASE_URL="$DATABASE_URL" \
      MOA_GATEWAY_TOKEN=restore-check-token \
      MODEL_PROVIDER=openai-compatible \
      MODEL_BASE_URL=http://127.0.0.1/restore-check \
      MODEL_ID=restore-check \
      VOICE_PROVIDER=loopback \
      DEFAULT_AGENT_HARNESS=echo \
      VOICE_MULTI_AGENT_HARNESSES=echo \
      PROBE_GEMINI_VERSION=0 \
      ALLOW_AGENT_WITHOUT_TOKEN=0 \
      "$NODE_BIN" server.js
  ) > "$gateway_log" 2>&1 &
  gateway_pid="$!"
}

validate

log "mode: $MODE"
log "backup source: ${BACKUP_DIR:-unset}"
log "scratch directory: ${SCRATCH_DIR:-unset}"
log "scratch database: explicit MOA_RESTORE_DATABASE_URL (redacted)"
log "scratch health port: ${GATEWAY_PORT:-unset}"
log "core table: $CORE_TABLE"

if [ "${#blockers[@]}" -gt 0 ]; then
  print_blockers
  if [ "$MODE" = "execute" ]; then
    die "restore check blocked"
  fi
fi

if [ "$MODE" != "execute" ]; then
  log "dry-run complete; no files written and no scratch gateway started"
  exit 0
fi

[ "${#blockers[@]}" -eq 0 ] || die "restore check blocked"

mkdir -p "$(dirname "$SCRATCH_DIR")"
mkdir "$SCRATCH_DIR"
mkdir "$SCRATCH_DIR/data-dir"

log "checking scratch database is empty"
existing_tables="$(scratch_table_count)"
[ "$existing_tables" = "0" ] || die "scratch database is not empty; refusing to restore into it"

log "restoring Postgres dump into scratch database"
restore_database
check_core_table

log "restoring DATA_DIR snapshot into scratch directory"
"$TAR_BIN" -C "$SCRATCH_DIR/data-dir" -xzf "$BACKUP_DIR/data-dir.tar.gz"

log "starting scratch gateway"
start_gateway
wait_for_health

log "restore check complete: $SCRATCH_DIR"
