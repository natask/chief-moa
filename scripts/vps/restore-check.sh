#!/usr/bin/env bash
# Prove a backup restores: rebuild a scratch gateway from the dump + snapshot
# and verify /health plus a core Postgres-backed read. Never touches the
# active stack: it runs under a separate compose project with its own volumes
# and a different published port, and it is deleted afterwards.
#
#   scripts/vps/restore-check.sh /opt/chief-moa/backups/<timestamp>
#
# Promotion is blocked until this passes for the backup taken beforehand.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

backup_dir="${1:-}"
release_dump="$backup_dir/release-control-postgres-dump.sql"
release_absent="$backup_dir/release-control-absent.txt"
if [ -z "$backup_dir" ] || [ ! -f "$backup_dir/postgres-dump.sql" ] \
  || [ ! -f "$backup_dir/data-dir.tar.gz" ] \
  || { [ ! -f "$release_dump" ] && [ ! -f "$release_absent" ]; } \
  || { [ -f "$release_dump" ] && [ -f "$release_absent" ]; }; then
  echo "Usage: restore-check.sh <backup with gateway dump, DATA_DIR, and exactly one release-control dump/absent marker>" >&2
  exit 1
fi
if [ -f "$release_absent" ] \
  && [ "$(cat "$release_absent")" != $'database=moa_release_control\nstate=absent' ]; then
  echo "Release-control absent marker is malformed." >&2
  exit 1
fi

require_env_file
cd "$APP_DIR"

SCRATCH_PROJECT="moa-restore-check"
SCRATCH_PORT="${SCRATCH_PORT:-18788}"

# Scratch stack: base compose file only (no Caddy, so no 80/443 conflict),
# its own project name (so its own fresh volumes), loopback-only scratch port.
scratch_compose() {
  GATEWAY_PORT="$SCRATCH_PORT" GATEWAY_BIND=127.0.0.1 \
    docker compose -p "$SCRATCH_PROJECT" -f docker-compose.yml --env-file "$ENV_FILE" "$@"
}

cleanup() {
  scratch_compose down -v >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "Starting scratch Postgres..."
scratch_compose up -d --wait postgres

echo "Restoring Postgres dump..."
scratch_compose exec -T postgres psql -q -U moa -d moa_gateway < "$backup_dir/postgres-dump.sql" >/dev/null

echo "Restoring release-control Postgres dump..."
if [ -f "$release_dump" ]; then
  scratch_compose exec -T postgres createdb -U moa moa_release_control
  scratch_compose exec -T postgres psql -q -U moa -d moa_release_control \
    < "$release_dump" >/dev/null
fi

echo "Restoring DATA_DIR snapshot into the scratch volume..."
scratch_compose run --rm --no-deps -T gateway tar -xzf - -C /data < "$backup_dir/data-dir.tar.gz"

echo "Starting scratch gateway..."
scratch_compose up -d --wait gateway

wait_for_gateway_health "http://127.0.0.1:$SCRATCH_PORT/health" 30

token="$(env_value MOA_GATEWAY_TOKEN)"
echo "Verifying a core Postgres-backed read (/v1/supervisor/status)..."
curl -fsS --max-time 5 -H "Authorization: Bearer $token" \
  "http://127.0.0.1:$SCRATCH_PORT/v1/supervisor/status" >/dev/null

count="$(scratch_compose exec -T postgres psql -tA -U moa -d moa_gateway -c 'select count(*) from nodes;')"
if [ -f "$release_dump" ]; then
  release_count="$(scratch_compose exec -T postgres psql -tA -U moa -d moa_release_control \
    -c 'select count(*) from release_assignment_events;')"
else
  release_count=0
fi
echo "Restore check passed: /health ok, supervisor status ok, nodes=$count, release_assignments=$release_count"
echo "Scratch stack removed; the active stack was not touched."
