#!/usr/bin/env bash
# Safe-by-default pre-promotion backup lane for Chief Moa VPS deployments.
#
# Canonical live Compose/VPS operations use scripts/vps/backup.sh. This root
# entrypoint remains the standalone explicit-input backup tool from the
# agent-control-plane lane.
#
# This script intentionally does not source .env files. Provide the source
# database URL, source DATA_DIR, and destination backup directory explicitly.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

MODE="dry-run"
BACKUP_DIR="${MOA_BACKUP_DIR:-}"
DATABASE_URL="${MOA_BACKUP_DATABASE_URL:-}"
DATA_DIR="${MOA_BACKUP_DATA_DIR:-}"
REMOTE="${MOA_BACKUP_REMOTE:-}"
LABEL="${MOA_BACKUP_LABEL:-pre-promotion}"
PG_DUMP_BIN="${MOA_BACKUP_PG_DUMP_BIN:-pg_dump}"
PG_CONNECT_TIMEOUT="${MOA_BACKUP_PG_CONNECT_TIMEOUT:-10}"
TAR_BIN="${MOA_BACKUP_TAR_BIN:-tar}"
GZIP_BIN="${MOA_BACKUP_GZIP_BIN:-gzip}"
RSYNC_BIN="${MOA_BACKUP_RSYNC_BIN:-rsync}"
RSYNC_RSH="${MOA_BACKUP_RSYNC_RSH:-ssh -o BatchMode=yes}"
SHASUM_BIN="${MOA_BACKUP_SHASUM_BIN:-shasum}"

tmp_dir=""

usage() {
  cat <<'USAGE'
Usage:
  scripts/vps-backup.sh --dry-run
  scripts/vps-backup.sh --execute

Required explicit configuration, via env or matching args:
  MOA_BACKUP_DIR            Directory where a timestamped backup directory is written.
  MOA_BACKUP_DATABASE_URL   Source Postgres connection URL. Never printed.
  MOA_BACKUP_DATA_DIR       Source gateway DATA_DIR path.

Optional:
  MOA_BACKUP_REMOTE         ssh target for a remote DATA_DIR rsync, e.g. user@host.
  MOA_BACKUP_LABEL          Backup directory label suffix. Default: pre-promotion.
  MOA_BACKUP_RSYNC_RSH      Remote shell for rsync. Default: ssh -o BatchMode=yes.

Args:
  --backup-dir DIR
  --database-url URL        Prefer env so the URL is not stored in shell history.
  --data-dir DIR
  --remote USER@HOST
  --label LABEL
  --dry-run                 Validate and print a sanitized plan. Default.
  --execute                 Write the backup artifacts.

Artifacts:
  postgres.sql.gz           Plain pg_dump output, gzip-compressed.
  data-dir.tar.gz           Snapshot of DATA_DIR contents.
  SHA256SUMS                Checksums for the two artifacts.
  manifest.txt              Non-secret backup metadata.

This script never reads .env and never restarts, reloads, or promotes the active
deployment.
USAGE
}

log() {
  printf '[vps-backup] %s\n' "$*" >&2
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

cleanup() {
  if [ -n "$tmp_dir" ] && [ -d "$tmp_dir" ]; then
    rm -rf "$tmp_dir"
  fi
}
trap cleanup EXIT

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
    --data-dir)
      require_arg "$1" "${2:-}"
      DATA_DIR="$2"
      shift 2
      ;;
    --remote)
      require_arg "$1" "${2:-}"
      REMOTE="$2"
      shift 2
      ;;
    --label)
      require_arg "$1" "${2:-}"
      LABEL="$2"
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

sanitize_label() {
  local raw="$1"
  local cleaned
  cleaned="$(printf '%s' "$raw" | tr -c 'A-Za-z0-9._-' '-' | sed 's/^-*//; s/-*$//; s/--*/-/g')"
  if [ -n "$cleaned" ]; then
    printf '%s\n' "$cleaned"
  else
    printf 'backup\n'
  fi
}

git_sha() {
  git -C "$ROOT_DIR" rev-parse --verify HEAD 2>/dev/null || printf 'unknown\n'
}

validate() {
  [ -n "$BACKUP_DIR" ] || add_blocker "MOA_BACKUP_DIR or --backup-dir is required"
  [ -n "$DATABASE_URL" ] || add_blocker "MOA_BACKUP_DATABASE_URL or --database-url is required"
  [ -n "$DATA_DIR" ] || add_blocker "MOA_BACKUP_DATA_DIR or --data-dir is required"

  need_command "Postgres dump" "$PG_DUMP_BIN"
  need_command "tar archive" "$TAR_BIN"
  need_command "gzip compression" "$GZIP_BIN"
  need_command "checksums" "$SHASUM_BIN"

  if [ -n "$REMOTE" ]; then
    need_command "remote DATA_DIR snapshot" "$RSYNC_BIN"
  elif [ -n "$DATA_DIR" ] && [ ! -d "$DATA_DIR" ]; then
    add_blocker "local MOA_BACKUP_DATA_DIR does not exist or is not a directory: $DATA_DIR"
  fi
}

print_blockers() {
  local blocker
  for blocker in "${blockers[@]}"; do
    log "blocker: $blocker"
  done
}

validate

safe_label="$(sanitize_label "$LABEL")"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
target_dir="$BACKUP_DIR/$timestamp-$safe_label"

log "mode: $MODE"
log "backup destination: $target_dir"
if [ -n "$REMOTE" ]; then
  log "DATA_DIR source: $REMOTE:$DATA_DIR"
else
  log "DATA_DIR source: $DATA_DIR"
fi
log "database source: explicit MOA_BACKUP_DATABASE_URL (redacted)"

if [ "${#blockers[@]}" -gt 0 ]; then
  print_blockers
  if [ "$MODE" = "execute" ]; then
    die "backup blocked"
  fi
fi

if [ "$MODE" != "execute" ]; then
  log "dry-run complete; no files written"
  exit 0
fi

[ "${#blockers[@]}" -eq 0 ] || die "backup blocked"
mkdir -p "$BACKUP_DIR"
[ ! -e "$target_dir" ] || die "backup target already exists: $target_dir"

tmp_dir="$target_dir.tmp"
[ ! -e "$tmp_dir" ] || die "temporary backup target already exists: $tmp_dir"
mkdir -p "$tmp_dir"

log "dumping Postgres to backup artifact"
PGDATABASE="$DATABASE_URL" \
PGCONNECT_TIMEOUT="$PG_CONNECT_TIMEOUT" \
PGPASSFILE=/dev/null \
PGSERVICEFILE=/dev/null \
  "$PG_DUMP_BIN" --no-password --format=plain --no-owner --no-acl --file "$tmp_dir/postgres.sql"
"$GZIP_BIN" -9 < "$tmp_dir/postgres.sql" > "$tmp_dir/postgres.sql.gz"
rm -f "$tmp_dir/postgres.sql"

log "snapshotting DATA_DIR"
if [ -n "$REMOTE" ]; then
  mkdir -p "$tmp_dir/data-dir"
  RSYNC_RSH="$RSYNC_RSH" "$RSYNC_BIN" -a "$REMOTE:$DATA_DIR/" "$tmp_dir/data-dir/"
  "$TAR_BIN" -C "$tmp_dir/data-dir" -czf "$tmp_dir/data-dir.tar.gz" .
  rm -rf "$tmp_dir/data-dir"
else
  "$TAR_BIN" -C "$DATA_DIR" -czf "$tmp_dir/data-dir.tar.gz" .
fi

(
  cd "$tmp_dir"
  "$SHASUM_BIN" -a 256 postgres.sql.gz data-dir.tar.gz > SHA256SUMS
)

cat > "$tmp_dir/manifest.txt" <<EOF
kind=chief-moa-vps-backup
created_at_utc=$timestamp
label=$LABEL
git_sha=$(git_sha)
postgres_dump=postgres.sql.gz
postgres_dump_format=plain-gzip
data_snapshot=data-dir.tar.gz
data_dir_source_mode=$([ -n "$REMOTE" ] && printf 'remote' || printf 'local')
data_dir_source=$([ -n "$REMOTE" ] && printf '%s:%s' "$REMOTE" "$DATA_DIR" || printf '%s' "$DATA_DIR")
database_source=explicit-env-redacted
script=scripts/vps-backup.sh
EOF

mv "$tmp_dir" "$target_dir"
tmp_dir=""
log "backup complete: $target_dir"
