#!/usr/bin/env bash
# Enable the already-migrated release-control runtime with rollback-safe env handling.
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

[ "${1:-}" = "--direct-enable" ] && [ "${2:-}" = "--target" ] \
  && [ "${3:-}" = "chief-moa-production" ] && [ "$#" -eq 3 ] \
  || { echo "Release-control activation requires explicit production authority." >&2; exit 64; }

require_env_file
cd "$APP_DIR"
port="$(env_value GATEWAY_PORT)"; port="${port:-8787}"
health_url="http://127.0.0.1:$port/health"
backup="${ENV_FILE}.pre-release-control.$$"
cp -p "$ENV_FILE" "$backup"
activated=0

rollback() {
  status=$?
  trap - EXIT
  if [ "$activated" -eq 1 ]; then
    mv -f "$backup" "$ENV_FILE"
    compose up -d --no-deps gateway >/dev/null 2>&1 || true
    wait_for_gateway_health "$health_url" 45 >/dev/null 2>&1 || true
  else
    rm -f "$backup"
  fi
  exit "$status"
}
trap rollback EXIT

curl -fsS --max-time 15 "$health_url" | node_runtime -e '
  let input = "";
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    if (JSON.parse(input).voice_stream?.activity?.drain_safe !== true) process.exit(1);
  });
'
"$SCRIPT_DIR/install-release-control-database-credentials.sh" --enable >/dev/null
activated=1
compose up -d --no-deps gateway
wait_for_gateway_health "$health_url" 45
curl -fsS --max-time 15 "$health_url" | node_runtime -e '
  let input = "";
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const release = JSON.parse(input).release_control || {};
    if (release.configured !== true || release.ready !== true || release.storage !== "postgres") process.exit(1);
  });
'
rm -f "$backup"
activated=0
trap - EXIT
echo "Release-control runtime enabled and healthy."
