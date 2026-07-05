#!/usr/bin/env bash
# Back up the running gateway stack: a Postgres dump plus a DATA_DIR snapshot.
# Read-only against the active stack (pg_dump + tar out of the containers).
#
#   scripts/vps/backup.sh            -> /opt/chief-moa/backups/<utc timestamp>/
#
# Run this (plus restore-check.sh) before any promotion: an update, an active
# URL change, or an active-service restart.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

require_env_file
cd "$APP_DIR"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out_dir="$BACKUP_DIR/$stamp"
tmp_dir="$BACKUP_DIR/$stamp.tmp"

cleanup() {
  if [ -d "$tmp_dir" ]; then
    rm -rf "$tmp_dir"
  fi
}
trap cleanup EXIT

mkdir -p "$BACKUP_DIR"
if [ -e "$out_dir" ] || [ -e "$tmp_dir" ]; then
  echo "Backup target already exists for timestamp $stamp." >&2
  exit 1
fi
mkdir -p "$tmp_dir"

echo "Dumping Postgres..."
compose exec -T postgres pg_dump -U moa -d moa_gateway > "$tmp_dir/postgres-dump.sql"

echo "Snapshotting DATA_DIR..."
compose exec -T gateway tar -czf - -C /data . > "$tmp_dir/data-dir.tar.gz"

(
  cd "$tmp_dir"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum postgres-dump.sql data-dir.tar.gz > SHA256SUMS
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 postgres-dump.sql data-dir.tar.gz > SHA256SUMS
  fi
)

git_sha="$(git -C "$APP_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
cat > "$tmp_dir/manifest.txt" <<MANIFEST
created_utc=$stamp
git_sha=$git_sha
postgres_dump=postgres-dump.sql
data_dir_snapshot=data-dir.tar.gz
checksums=$([ -f "$tmp_dir/SHA256SUMS" ] && echo SHA256SUMS || echo unavailable)
compose_project=$COMPOSE_PROJECT
MANIFEST

mv "$tmp_dir" "$out_dir"
trap - EXIT
echo "Backup written to $out_dir"
echo "Verify it with: $SCRIPT_DIR/restore-check.sh $out_dir"
