#!/usr/bin/env bash
set -euo pipefail

REMOTE="${REMOTE:-reclaim@10.147.17.10}"
REMOTE_DIR="${REMOTE_DIR:-/home/reclaim-ethiopia/moa-assistant/gateway}"
REMOTE_DATA_DIR="${REMOTE_DATA_DIR:-/home/reclaim-ethiopia/moa-assistant-data/moa_gateway}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

ssh -o ConnectTimeout=10 "$REMOTE" "mkdir -p '$REMOTE_DIR/lib' '$REMOTE_DIR/agent-workflows' '$REMOTE_DIR/scripts' '$REMOTE_DIR/public' '$REMOTE_DIR/deploy/main-machine' '$REMOTE_DATA_DIR'"

rsync -az \
  "$ROOT_DIR/deploy/main-machine/" \
  "$REMOTE:$REMOTE_DIR/deploy/main-machine/"

rsync -az \
  "$ROOT_DIR/server.js" \
  "$ROOT_DIR/agent-launcher-profiles.json" \
  "$ROOT_DIR/package.json" \
  "$ROOT_DIR/package-lock.json" \
  "$REMOTE:$REMOTE_DIR/"

# Sync the whole lib/ and scripts/ dirs so the deploy never goes stale when new
# modules land (e.g. lib/brain.js, lib/memory-matcher.js, the new smoke scripts).
rsync -az \
  "$ROOT_DIR/lib/" \
  "$REMOTE:$REMOTE_DIR/lib/"

rsync -az \
  "$ROOT_DIR/agent-workflows/" \
  "$REMOTE:$REMOTE_DIR/agent-workflows/"

rsync -az \
  "$ROOT_DIR/scripts/" \
  "$REMOTE:$REMOTE_DIR/scripts/"

rsync -az \
  "$ROOT_DIR/public/" \
  "$REMOTE:$REMOTE_DIR/public/"

ssh "$REMOTE" "cd '$REMOTE_DIR' && npm ci && npm run check"

# The gateway runs as a user systemd unit (moa-gateway.service). Restart it and
# confirm health so this is a one-shot deploy, not just a file sync.
ssh "$REMOTE" "XDG_RUNTIME_DIR=/run/user/\$(id -u) systemctl --user restart moa-gateway.service && sleep 1 && curl -fsS http://127.0.0.1:8787/health >/dev/null && echo 'gateway restarted and healthy'"

echo "Synced + restarted gateway at $REMOTE:$REMOTE_DIR"
