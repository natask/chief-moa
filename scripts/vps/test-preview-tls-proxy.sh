#!/usr/bin/env bash
set -euo pipefail

root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT
mkdir -p "$root/bin"
cat > "$root/bin/docker" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$@" >> "$DOCKER_LOG"
SH
chmod +x "$root/bin/docker"

export DOCKER_LOG="$root/docker.log"
PATH="$root/bin:$PATH"
export PATH
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
start_preview_tls_proxy preview-probe 18789 http://127.0.0.1:18787

for expected in \
  'caddy@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648' \
  'caddy' 'reverse-proxy' '--internal-certs' '--disable-redirects' \
  'https://127.0.0.1:18789' 'http://127.0.0.1:18787'; do
  grep -Fx -- "$expected" "$DOCKER_LOG" >/dev/null
done
if grep -F -- '/var/run/docker.sock' "$DOCKER_LOG" >/dev/null; then
  echo 'preview TLS proxy must not receive the Docker socket' >&2
  exit 1
fi

echo 'isolated preview TLS proxy test passed'
