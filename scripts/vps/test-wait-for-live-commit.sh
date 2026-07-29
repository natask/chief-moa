#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

cat >"$TMP_DIR/curl" <<'EOF'
#!/usr/bin/env bash
printf '{"build":{"git_sha":"%s"}}\n' "$MOCK_LIVE_SHA"
EOF
chmod +x "$TMP_DIR/curl"

expected="0123456789abcdef0123456789abcdef01234567"
different="89abcdef0123456789abcdef0123456789abcdef"

PATH="$TMP_DIR:$PATH" \
MOCK_LIVE_SHA="$expected" \
MOA_LIVE_COMMIT_DEADLINE_SECONDS=2 \
MOA_LIVE_COMMIT_POLL_SECONDS=0.01 \
  bash "$ROOT_DIR/scripts/vps/wait-for-live-commit.sh" "$expected"

if PATH="$TMP_DIR:$PATH" \
  MOCK_LIVE_SHA="$different" \
  MOA_LIVE_COMMIT_DEADLINE_SECONDS=1 \
  MOA_LIVE_COMMIT_POLL_SECONDS=0.01 \
    bash "$ROOT_DIR/scripts/vps/wait-for-live-commit.sh" "$expected" >/dev/null 2>&1; then
  echo "wait-for-live-commit accepted a different commit" >&2
  exit 1
fi

echo "wait-for-live-commit tests: ok"
