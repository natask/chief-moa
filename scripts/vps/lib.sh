#!/usr/bin/env bash
# Shared settings for the VPS gateway scripts. Every script here operates on
# one compose project (chief-moa) whose named volumes are the shared event
# store: they survive image rebuilds and gateway restarts. Only `down -v` on
# the ACTIVE project would delete them, and no script here runs that.

MOA_ROOT="${MOA_ROOT:-/opt/chief-moa}"
APP_DIR="${APP_DIR:-$MOA_ROOT/app}"
ENV_FILE="${ENV_FILE:-$MOA_ROOT/gateway.env}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-chief-moa}"

# MOA_NO_TLS=1 runs the base stack without the Caddy TLS overlay (private
# networks only). Default includes TLS.
compose_files() {
  if [ "${MOA_NO_TLS:-0}" = "1" ]; then
    echo "-f docker-compose.yml"
  else
    echo "-f docker-compose.yml -f docker-compose.vps.yml"
  fi
}

compose() {
  # shellcheck disable=SC2046
  docker compose -p "$COMPOSE_PROJECT" $(compose_files) --env-file "$ENV_FILE" "$@"
}

require_env_file() {
  if [ ! -f "$ENV_FILE" ]; then
    echo "Missing env file: $ENV_FILE" >&2
    echo "Copy gateway/deploy/vps/gateway.env.example there and fill it in." >&2
    exit 1
  fi
}

env_value() {
  # Read one KEY=value from the env file without exporting the whole file.
  sed -n "s/^${1}=//p" "$ENV_FILE" | tail -n 1
}

wait_for_gateway_health() {
  # $1: health URL, $2: attempts (default 30, 2s apart)
  local url="$1" attempts="${2:-30}" i
  for i in $(seq 1 "$attempts"); do
    if curl -fsS --max-time 3 "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  echo "Gateway did not become healthy at $url" >&2
  return 1
}

# Promotion control scripts are JavaScript, but the supported droplet bootstrap
# intentionally installs Docker rather than a host Node toolchain. Use host Node
# when an operator provides it; otherwise run the same pinned Node 22 base image
# as the gateway with only the Moa root mounted and no Docker socket.
node_runtime() {
  if command -v node >/dev/null 2>&1; then
    node "$@"
    return
  fi
  command -v docker >/dev/null 2>&1 || { echo "Node runtime unavailable: install Node or Docker" >&2; return 69; }
  local image="${MOA_NODE_RUNTIME_IMAGE:-node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3}"
  docker run --rm --network host -i -v "$MOA_ROOT:$MOA_ROOT" -w "$APP_DIR" \
    -e MOA_CONTROL_PLANE_TOKEN -e MOA_ALLOW_OFFLINE_PROMOTION_EVIDENCE_TEST \
    -e MOA_DEPLOY_USER_TOKEN -e MOA_DEPLOY_REVIEWER_TOKEN \
    -e MOA_PREVIEW_DEPLOYER_TOKEN -e MOA_PRODUCTION_PROMOTER_TOKEN \
    -e MOA_PRODUCTION_PROMOTER_ID -e MOA_RECOVERY_WORKER_ID -e MOA_RECOVERY_CLAIM_ID \
    -e MOA_AUTH_SMOKE_ORIGIN -e MOA_AUTH_SMOKE_EMAIL -e MOA_AUTH_SMOKE_PASSWORD \
    -e NODE_TLS_REJECT_UNAUTHORIZED \
    "$image" node "$@"
}

start_preview_tls_proxy() {
  local name="$1" listen_port="$2" upstream_url="$3"
  local image="${MOA_PREVIEW_TLS_IMAGE:-caddy@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648}"
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" --network host "$image" caddy reverse-proxy \
    --internal-certs --disable-redirects \
    --from "https://127.0.0.1:$listen_port" --to "$upstream_url" >/dev/null
}
