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
mkdir -p "$out_dir"

echo "Dumping Postgres..."
compose exec -T postgres pg_dump -U moa -d moa_gateway > "$out_dir/postgres-dump.sql"

echo "Snapshotting DATA_DIR..."
compose exec -T gateway tar -czf - -C /data . > "$out_dir/data-dir.tar.gz"

git_sha="$(git -C "$APP_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
cat > "$out_dir/manifest.txt" <<MANIFEST
created_utc=$stamp
git_sha=$git_sha
postgres_dump=postgres-dump.sql
data_dir_snapshot=data-dir.tar.gz
compose_project=$COMPOSE_PROJECT
MANIFEST

echo "Backup written to $out_dir"
echo "Verify it with: $SCRIPT_DIR/restore-check.sh $out_dir"
