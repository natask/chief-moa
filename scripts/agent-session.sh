#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
provider="${1:-}"
shift || true

case "$provider" in
  codex|claude) ;;
  *) echo "usage: scripts/agent-session.sh codex|claude [guard options] [-- provider args]" >&2; exit 2 ;;
esac

guard_args=(launch --cwd "$PWD" --provider "$provider")
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do
  case "$1" in
    --allow-shared-branch|--user-request)
      guard_args+=("$1" "${2:?missing value for $1}")
      shift 2
      ;;
    --check-only)
      check_only=1
      shift
      ;;
    *) echo "unknown guard option: $1" >&2; exit 2 ;;
  esac
done
[ "$#" -eq 0 ] || shift

node "$ROOT_DIR/scripts/agent-workspace-guard.mjs" "${guard_args[@]}"
[ "${check_only:-0}" = 1 ] && exit 0
exec "$provider" "$@"
