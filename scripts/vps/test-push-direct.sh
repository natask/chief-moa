#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
FAKE_BIN="$TMP_DIR/bin"
mkdir -p "$FAKE_BIN"

cat > "$FAKE_BIN/ssh" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" > "$FAKE_SSH_RECEIPT"
SH
chmod +x "$FAKE_BIN/ssh"

git init --bare "$TMP_DIR/origin.git" >/dev/null
git clone -q "$ROOT_DIR" "$TMP_DIR/source"
cp "$ROOT_DIR/scripts/vps/push.sh" "$TMP_DIR/source/scripts/vps/push.sh"
git -C "$TMP_DIR/source" config user.name test
git -C "$TMP_DIR/source" config user.email test@example.invalid
git -C "$TMP_DIR/source" remote set-url origin "$TMP_DIR/origin.git"
node - "$TMP_DIR/source/scripts/deploy-targets.json" <<'NODE'
const fs = require("node:fs");
const file = process.argv[2];
const value = JSON.parse(fs.readFileSync(file, "utf8"));
value.production.identity = "chief-moa-production";
value.production.vps_ssh = "qa@example.invalid";
fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
NODE
git -C "$TMP_DIR/source" add scripts/vps/push.sh scripts/deploy-targets.json
git -C "$TMP_DIR/source" commit -m 'test: direct push fixture' >/dev/null
sha="$(git -C "$TMP_DIR/source" rev-parse HEAD)"

if (
  cd "$TMP_DIR/source"
  PATH="$FAKE_BIN:$PATH" \
    bash "$TMP_DIR/source/scripts/vps/push.sh" --host qa@example.invalid \
      --commit "$sha" >"$TMP_DIR/no-flag" 2>&1
); then exit 1; fi
[ ! -e "$TMP_DIR/ssh" ]

(
cd "$TMP_DIR/source"
FAKE_SSH_RECEIPT="$TMP_DIR/ssh" PATH="$FAKE_BIN:$PATH" \
  bash "$TMP_DIR/source/scripts/vps/push.sh" --direct-deploy \
    --target chief-moa-production --host qa@example.invalid --commit "$sha" \
    >/dev/null
)
grep -Fq '/opt/chief-moa/app/scripts/vps/promote-candidate.sh' "$TMP_DIR/ssh"
grep -Fq ' master' "$TMP_DIR/ssh"
test "$(git --git-dir="$TMP_DIR/origin.git" rev-parse refs/heads/master)" = "$sha"
test -z "$(git --git-dir="$TMP_DIR/origin.git" for-each-ref \
  --format='%(refname:short)' 'refs/heads/direct-candidate-*')"

printf 'moved\n' >> "$TMP_DIR/source/README.md"
git -C "$TMP_DIR/source" add README.md
git -C "$TMP_DIR/source" commit -m moved >/dev/null
if (cd "$TMP_DIR/source" && FAKE_SSH_RECEIPT="$TMP_DIR/moved-ssh" PATH="$FAKE_BIN:$PATH" \
  bash "$TMP_DIR/source/scripts/vps/push.sh" --direct-deploy \
    --target chief-moa-production --host qa@example.invalid --commit "$sha" \
    >"$TMP_DIR/moved" 2>&1); then exit 1; fi
[ ! -e "$TMP_DIR/moved-ssh" ]
grep -Fq 'HEAD moved after verification' "$TMP_DIR/moved"

echo "direct gateway push contract passed (explicit authority, exact SHA, guarded promoter)."
