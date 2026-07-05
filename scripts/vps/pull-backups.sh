#!/usr/bin/env bash
# Pull completed VPS backup directories to an operator-controlled machine.
# Dry-run is the default so setup can be checked without copying data.

set -euo pipefail

MODE="dry-run"
HOST="${MOA_VPS_BACKUP_HOST:-}"
REMOTE_DIR="${MOA_VPS_BACKUP_REMOTE_DIR:-/opt/chief-moa/backups}"
DEST_DIR="${MOA_VPS_BACKUP_DEST_DIR:-}"
RSYNC_BIN="${MOA_VPS_BACKUP_RSYNC_BIN:-rsync}"
RSYNC_RSH="${MOA_VPS_BACKUP_RSYNC_RSH:-ssh -o BatchMode=yes}"

usage() {
  cat <<'USAGE'
Usage:
  scripts/vps/pull-backups.sh --host root@vps --dest ~/Backups/chief-moa-vps
  scripts/vps/pull-backups.sh --execute --host root@vps --dest ~/Backups/chief-moa-vps

Options:
  --host USER@HOST       VPS SSH target. Required unless MOA_VPS_BACKUP_HOST is set.
  --remote-dir DIR       Remote backup directory. Default: /opt/chief-moa/backups.
  --dest DIR             Local backup mirror destination. Required.
  --dry-run              Print the sanitized plan only. Default.
  --execute              Create DEST and rsync completed backup directories.

The script excludes *.tmp backup directories so off-host copies never capture a
half-written backup. It does not delete local backups when remote retention
changes.
USAGE
}

die() {
  printf '[vps-pull-backups] ERROR: %s\n' "$*" >&2
  exit 1
}

require_arg() {
  [ -n "${2:-}" ] || die "$1 requires a value"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --host)
      require_arg "$1" "${2:-}"
      HOST="$2"
      shift 2
      ;;
    --remote-dir)
      require_arg "$1" "${2:-}"
      REMOTE_DIR="$2"
      shift 2
      ;;
    --dest)
      require_arg "$1" "${2:-}"
      DEST_DIR="$2"
      shift 2
      ;;
    --dry-run)
      MODE="dry-run"
      shift
      ;;
    --execute)
      MODE="execute"
      shift
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

[ -n "$HOST" ] || die "--host or MOA_VPS_BACKUP_HOST is required"
[ -n "$DEST_DIR" ] || die "--dest or MOA_VPS_BACKUP_DEST_DIR is required"
command -v "$RSYNC_BIN" >/dev/null 2>&1 || die "missing rsync: $RSYNC_BIN"

printf '[vps-pull-backups] mode: %s\n' "$MODE"
printf '[vps-pull-backups] source: %s:%s\n' "$HOST" "$REMOTE_DIR"
printf '[vps-pull-backups] destination: %s\n' "$DEST_DIR"

if [ "$MODE" != "execute" ]; then
  printf '[vps-pull-backups] dry-run complete; no files copied\n'
  exit 0
fi

mkdir -p "$DEST_DIR"
RSYNC_RSH="$RSYNC_RSH" "$RSYNC_BIN" -a \
  --exclude='*.tmp/' \
  --exclude='.tmp/' \
  "$HOST:$REMOTE_DIR/" "$DEST_DIR/"

cat > "$DEST_DIR/.chief-moa-last-pull" <<EOF
pulled_at_utc=$(date -u +%Y%m%dT%H%M%SZ)
source=$HOST:$REMOTE_DIR
script=scripts/vps/pull-backups.sh
EOF

printf '[vps-pull-backups] pull complete\n'
