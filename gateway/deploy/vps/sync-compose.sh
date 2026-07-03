#!/usr/bin/env bash
set -euo pipefail

REMOTE="${VPS_REMOTE:-${REMOTE:-}}"
REMOTE_DIR="${VPS_DIR:-/opt/chief-moa}"
GATEWAY_URL="${VPS_GATEWAY_URL:-${GATEWAY_URL:-}}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

if [ -z "$REMOTE" ]; then
  echo "VPS_REMOTE is required, for example: VPS_REMOTE=root@203.0.113.10" >&2
  exit 64
fi

ssh -o BatchMode=yes -o ConnectTimeout=10 "$REMOTE" "mkdir -p '$REMOTE_DIR/gateway'"

rsync -az \
  "$ROOT_DIR/docker-compose.yml" \
  "$REMOTE:$REMOTE_DIR/docker-compose.yml"

rsync -az --delete \
  --exclude '.env' \
  --exclude '.env.*' \
  --exclude 'data' \
  --exclude 'node_modules' \
  "$ROOT_DIR/gateway/" \
  "$REMOTE:$REMOTE_DIR/gateway/"

ssh "$REMOTE" "cd '$REMOTE_DIR' && test -f .env || { echo 'Missing $REMOTE_DIR/.env. Copy gateway/deploy/vps/env.example and fill secrets first.' >&2; exit 66; }"
ssh "$REMOTE" "cd '$REMOTE_DIR' && docker compose --env-file .env config >/dev/null"
ssh "$REMOTE" "cd '$REMOTE_DIR' && docker compose --env-file .env up -d --build"
ssh "$REMOTE" "cd '$REMOTE_DIR' && docker compose ps"
ssh "$REMOTE" "cd '$REMOTE_DIR' && set -a && . ./.env && set +a && curl -fsS http://127.0.0.1:\${GATEWAY_HOST_PORT:-\${PORT:-8787}}/health >/dev/null && echo 'gateway container healthy on localhost'"

if [ -n "$GATEWAY_URL" ]; then
  curl -fsS "$GATEWAY_URL/health" >/dev/null
  echo "gateway reachable at $GATEWAY_URL"
else
  echo "VPS_GATEWAY_URL not set; skipped public /health smoke"
fi
