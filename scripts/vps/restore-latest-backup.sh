#!/usr/bin/env bash
# Run the scratch restore check against the newest complete VPS backup.
# Intended for unattended timer use; it never touches the active compose
# project because restore-check.sh uses a separate project and scratch port.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

MODE="execute"

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) MODE="dry-run"; shift ;;
    --execute) MODE="execute"; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

require_env_file

latest_backup=""
if [ -d "$BACKUP_DIR" ]; then
  for candidate in "$BACKUP_DIR"/*; do
    [ -d "$candidate" ] || continue
    case "$candidate" in
      *.tmp) continue ;;
    esac
    [ -f "$candidate/postgres-dump.sql" ] || continue
    [ -f "$candidate/data-dir.tar.gz" ] || continue
    if [ -z "$latest_backup" ] || [ "$candidate" -nt "$latest_backup" ]; then
      latest_backup="$candidate"
    fi
  done
fi

if [ -z "$latest_backup" ]; then
  echo "No complete backup found under $BACKUP_DIR." >&2
  exit 1
fi

echo "Latest complete backup: $latest_backup"
if [ "$MODE" = "dry-run" ]; then
  echo "Dry-run only; would execute: $SCRIPT_DIR/restore-check.sh $latest_backup"
  exit 0
fi

"$SCRIPT_DIR/restore-check.sh" "$latest_backup"
