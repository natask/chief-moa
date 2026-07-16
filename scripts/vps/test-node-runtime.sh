#!/usr/bin/env bash
set -euo pipefail

root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT
mkdir -p "$root/bin" "$root/moa/app"

cat > "$root/bin/docker" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$DOCKER_LOG"
cat >/dev/null
SH
chmod +x "$root/bin/docker"

export DOCKER_LOG="$root/docker.log"
export MOA_ROOT="$root/moa"
export APP_DIR="$MOA_ROOT/app"
PATH="$root/bin:/usr/bin:/bin"
export PATH

# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
printf '{"ok":true}\n' | node_runtime -e 'process.exit(0)'

grep -Fx -- 'run' "$DOCKER_LOG" >/dev/null
grep -Fx -- '--network' "$DOCKER_LOG" >/dev/null
grep -Fx -- 'host' "$DOCKER_LOG" >/dev/null
grep -Fx -- "$MOA_ROOT:$MOA_ROOT" "$DOCKER_LOG" >/dev/null
grep -Fx -- "$APP_DIR" "$DOCKER_LOG" >/dev/null
grep -Fx -- 'node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3' "$DOCKER_LOG" >/dev/null
grep -Fx -- 'node' "$DOCKER_LOG" >/dev/null
if grep -F -- '/var/run/docker.sock' "$DOCKER_LOG" >/dev/null; then
  echo 'node runtime must not receive the Docker socket' >&2
  exit 1
fi

echo 'containerized Node runtime test passed'
