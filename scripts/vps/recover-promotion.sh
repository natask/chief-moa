#!/usr/bin/env bash
# Complete an interrupted promotion after M4 may have accepted its immutable
# effect. This never rebuilds, restarts, checks out, or reapplies the gateway.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"
JOURNAL="${MOA_PROMOTION_JOURNAL_FILE:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --journal) JOURNAL="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 64 ;;
  esac
done
[ -n "$JOURNAL" ] && [ -f "$JOURNAL" ] || { echo "A durable promotion --journal is required" >&2; exit 65; }
node_runtime "$SCRIPT_DIR/record-promotion-receipt.js" --recover --journal "$JOURNAL"
