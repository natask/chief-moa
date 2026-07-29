#!/usr/bin/env bash
set -euo pipefail

# Observe an already-authorized pull promotion from the operator machine. This
# intentionally does not run on a paid GitHub-hosted runner: GitHub's runner
# network has repeatedly failed to read the public health endpoint while an
# ordinary client could read it immediately.

EXPECTED_GIT_SHA="${1:-}"
HEALTH_URL="${MOA_GATEWAY_HEALTH_URL:-https://api.agee.app/health}"
DEADLINE_SECONDS="${MOA_LIVE_COMMIT_DEADLINE_SECONDS:-2700}"
POLL_SECONDS="${MOA_LIVE_COMMIT_POLL_SECONDS:-15}"

if [[ ! "$EXPECTED_GIT_SHA" =~ ^[0-9a-fA-F]{7,64}$ ]]; then
  echo "usage: scripts/vps/wait-for-live-commit.sh <expected-git-sha>" >&2
  exit 2
fi
if [[ ! "$DEADLINE_SECONDS" =~ ^[1-9][0-9]*$ ]] || [[ ! "$POLL_SECONDS" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
  echo "deadline and poll interval must be positive numeric values" >&2
  exit 2
fi

EXPECTED_GIT_SHA="$(printf '%s' "$EXPECTED_GIT_SHA" | tr '[:upper:]' '[:lower:]')"
deadline="$(( $(date +%s) + DEADLINE_SECONDS ))"
live_sha="unavailable"

while [ "$(date +%s)" -lt "$deadline" ]; do
  health="$(curl -fsS --connect-timeout 5 --max-time 10 \
    -H 'Cache-Control: no-cache' "$HEALTH_URL" || true)"
  observed="$(ruby -rjson -e '
    health = JSON.parse(STDIN.read)
    sha = health.dig("build", "git_sha")
    abort unless sha.is_a?(String) && sha.match?(/\A[0-9a-f]{7,64}\z/i)
    print sha.downcase
  ' <<<"$health" 2>/dev/null || true)"
  [ -z "$observed" ] || live_sha="$observed"

  if [ "$live_sha" = "$EXPECTED_GIT_SHA" ]; then
    echo "[live-gateway] active gateway serves exact commit $EXPECTED_GIT_SHA"
    exit 0
  fi

  echo "[live-gateway] waiting: expected=$EXPECTED_GIT_SHA observed=$live_sha"
  sleep "$POLL_SECONDS"
done

echo "[live-gateway] ERROR: active gateway stayed at $live_sha; expected $EXPECTED_GIT_SHA after ${DEADLINE_SECONDS}s" >&2
exit 1
