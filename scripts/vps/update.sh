#!/usr/bin/env bash
# Update the running VPS gateway to a new git ref while preserving the event
# store. Backup + restore check run first (versioned-state rule), then only
# the gateway service is rebuilt and recreated: Postgres and Caddy keep
# running, and the named data volumes are untouched. Schema changes apply on
# gateway boot (schema.sql is idempotent).
#
#   scripts/vps/update.sh                # update to origin/master
#   scripts/vps/update.sh --ref my-branch
#   scripts/vps/update.sh --skip-backup  # only when no backup is possible

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

REF="${MOA_REF:-master}"
SKIP_BACKUP=0

while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="$2"; shift 2 ;;
    --skip-backup) SKIP_BACKUP=1; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

require_env_file
cd "$APP_DIR"

# 1. Backup and prove the restore path before mutating the active service.
if [ "$SKIP_BACKUP" = "1" ]; then
  echo "WARNING: skipping backup + restore check (--skip-backup)."
else
  "$SCRIPT_DIR/backup.sh"
  latest_backup="$(ls -1d "$BACKUP_DIR"/*/ 2>/dev/null | sort | tail -n 1)"
  if [ -z "$latest_backup" ]; then
    echo "Backup did not create a backup directory under $BACKUP_DIR." >&2
    exit 1
  fi
  "$SCRIPT_DIR/restore-check.sh" "${latest_backup%/}"
fi

# 2. Move the checkout to the requested ref. This checkout is a deploy
# artifact, never a workspace (fix work happens in branches elsewhere), so
# --force discarding stray local files is the wanted behavior: without it a
# single untracked file that the new ref tracks wedges every update.
old_sha="$(git -C "$APP_DIR" rev-parse --short HEAD)"
git -C "$APP_DIR" fetch origin
git -C "$APP_DIR" checkout --force --detach "origin/$REF" 2>/dev/null \
  || git -C "$APP_DIR" checkout --force --detach "$REF"
new_sha="$(git -C "$APP_DIR" rev-parse --short HEAD)"

# 3. Rebuild and recreate only the gateway. Volumes and other services stay.
compose build gateway
compose up -d --no-deps gateway

port="$(env_value GATEWAY_PORT)"
port="${port:-8787}"
wait_for_gateway_health "http://127.0.0.1:$port/health" 45

# 4. If the Caddyfile changed in this update, apply it with a validated
# graceful reload. Requires the directory mount (docker-compose.vps.yml);
# reload keeps the old config on validation failure, so the front never
# drops. Non-fatal: a reload failure leaves the previous routes serving.
if ! git -C "$APP_DIR" diff --quiet "$old_sha" "$new_sha" -- gateway/deploy/vps/Caddyfile; then
  caddy_container="$(compose ps -q caddy)"
  if [ -n "$caddy_container" ]; then
    if docker exec "$caddy_container" caddy validate --config /etc/caddy/Caddyfile 2>/dev/null; then
      docker exec "$caddy_container" caddy reload --config /etc/caddy/Caddyfile \
        && echo "Caddyfile changed: reloaded caddy." \
        || echo "WARNING: caddy reload failed; previous routes still serving." >&2
    else
      echo "WARNING: new Caddyfile failed validation; caddy keeps the old config." >&2
    fi
  fi
fi

domain="$(env_value MOA_DOMAIN)"
echo "Updated gateway $old_sha -> $new_sha"
echo "Health: https://$domain/health"
