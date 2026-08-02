#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

REMOTE="$TEST_ROOT/origin.git"
SOURCE="$TEST_ROOT/source"
ACTIVE="$TEST_ROOT/active"
PROMOTION_LOG="$TEST_ROOT/promotion.log"
mkdir -p "$TEST_ROOT/bin"
cat >"$TEST_ROOT/bin/flock" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$TEST_ROOT/bin/flock"

git init --bare "$REMOTE" >/dev/null
git init -b master "$SOURCE" >/dev/null
git -C "$SOURCE" config user.name "Auto Update Test"
git -C "$SOURCE" config user.email "auto-update@example.invalid"
mkdir -p "$SOURCE/scripts/vps"
cat >"$SOURCE/scripts/vps/promote-candidate.sh" <<'EOF'
#!/usr/bin/env bash
echo "stale promoter executed" >&2
exit 99
EOF
git -C "$SOURCE" add scripts/vps/promote-candidate.sh
git -C "$SOURCE" commit -m "test: old deployed promoter" >/dev/null
old_sha="$(git -C "$SOURCE" rev-parse HEAD)"
git -C "$SOURCE" remote add origin "$REMOTE"
git -C "$SOURCE" push origin master:master master:vps-deploy >/dev/null

cat >"$SOURCE/scripts/vps/promote-candidate.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s|%s|%s\n' "$(git -C "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)" rev-parse HEAD)" "$APP_DIR" "$1" >"$TEST_PROMOTION_LOG"
exit "${TEST_PROMOTER_STATUS:-0}"
EOF
git -C "$SOURCE" add scripts/vps/promote-candidate.sh
git -C "$SOURCE" commit -m "fix: candidate promotion contract" >/dev/null
candidate_sha="$(git -C "$SOURCE" rev-parse HEAD)"
git -C "$SOURCE" push origin master:master master:vps-deploy >/dev/null

git clone "$REMOTE" "$ACTIVE" >/dev/null
git -C "$ACTIVE" checkout --detach "$old_sha" >/dev/null

run_update() {
  PATH="$TEST_ROOT/bin:$PATH" \
    TEST_PROMOTION_LOG="$PROMOTION_LOG" TEST_PROMOTER_STATUS="${1:-0}" \
    MOA_VPS_APP_DIR="$ACTIVE" MOA_ROOT="$TEST_ROOT/moa" \
    MOA_AUTO_UPDATE_LOCK_FILE="$TEST_ROOT/auto-update.lock" \
    MOA_AUTO_UPDATE_CANDIDATE_ROOT="$TEST_ROOT/candidates" \
    bash "$SCRIPT_DIR/auto-update.sh"
}

run_update 0
expected="$candidate_sha|$ACTIVE|vps-deploy"
actual="$(cat "$PROMOTION_LOG")"
[ "$actual" = "$expected" ] || {
  echo "candidate promoter mismatch: expected $expected, got $actual" >&2
  exit 1
}
[ "$(git -C "$ACTIVE" rev-parse HEAD)" = "$old_sha" ]
[ ! -e "$TEST_ROOT/candidates/${candidate_sha:0:12}/source" ]

rm -f "$PROMOTION_LOG"
output="$(run_update 75)"
grep -q 'promotion safely deferred' <<<"$output"
[ "$(cut -d'|' -f1 "$PROMOTION_LOG")" = "$candidate_sha" ]

echo "auto-update candidate bootstrap tests passed"
