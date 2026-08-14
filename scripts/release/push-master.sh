#!/usr/bin/env bash
# Locally verify a candidate, then fast-forward master without a PR or runner.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

fail() { echo "[push-master] ERROR: $*" >&2; exit 1; }
log() { echo "[push-master] $*"; }

[ "${1:-}" = "--direct-push" ] && [ "${2:-}" = "--target" ] && [ "${3:-}" = "master" ] \
  && [ "$#" -eq 3 ] \
  || fail "usage: scripts/release/push-master.sh --direct-push --target master"

branch="$(git branch --show-current)"
[ -n "$branch" ] || fail "detached HEAD; check out master"
[ "$branch" = master ] || fail "run from master; this repository does not create integration branches"
[ -z "$(git status --porcelain)" ] || fail "working tree is dirty"

git fetch origin master --quiet
git merge-base --is-ancestor origin/master HEAD \
  || fail "candidate does not contain current origin/master"
candidate="$(git rev-parse HEAD)"

node scripts/source-size-policy.js

if ! git diff --quiet origin/master HEAD -- gateway docker-compose.yml docker-compose.vps.yml scripts/vps; then
  bash scripts/release/local-release.sh gateway
fi
if ! git diff --quiet origin/master HEAD -- android_app gateway/lib/android-ota.js scripts/deploy-targets.json; then
  bash scripts/release/local-release.sh android
fi
if ! git diff --quiet origin/master HEAD -- browser_extension; then
  MOA_RELEASE_BASE_REF=origin/master bash scripts/release/local-release.sh extension
fi
if ! git diff --quiet origin/master HEAD -- apple_surfaces; then
  bash scripts/release/local-release.sh macos
fi
if ! git diff --quiet origin/master HEAD -- windows_app \
  .github/workflows/windows-native-core.yml .github/workflows/windows-surface-shell.yml; then
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) ;;
    *) fail "Windows changes require the local pre-master gate on a Windows host" ;;
  esac
  command -v dotnet >/dev/null || fail "Windows gate requires dotnet 8"
  command -v msbuild >/dev/null || fail "Windows gate requires Visual Studio MSBuild"
  (
    cd windows_app/core
    cargo fmt --check
    cargo test --locked
    cargo clippy --all-targets -- -D warnings
    cargo build --locked --target x86_64-pc-windows-msvc
  )
  node windows_app/scripts/verify-dictation-source.mjs
  dotnet test windows_app/Aggie.Windows.Tests/Aggie.Windows.Tests.csproj --configuration Release
  msbuild windows_app/Aggie.Windows/Aggie.Windows.csproj /restore /p:Platform=x64 /p:AppxPackageSigningEnabled=false
  node windows_app/scripts/package-windows-dictation-qa.mjs
fi
if ! git diff --quiet origin/master HEAD -- scripts/deploy.sh scripts/release release_control_plane; then
  bash -n scripts/deploy.sh scripts/release/local-release.sh scripts/release/push-master.sh \
    scripts/vps/push.sh scripts/vps/enable-release-control.sh android_app/deploy/ota/sync-vps.sh
  node --test scripts/release/test-release-evidence.mjs scripts/release/test-local-first-release.mjs
  bash scripts/test-deploy-android.sh
  bash android_app/deploy/ota/test-sync-vps.sh
  bash scripts/vps/test-push-direct.sh
  (cd release_control_plane && npm run check)
fi

test "$(git rev-parse HEAD)" = "$candidate" || fail "HEAD moved during local verification"
[ -z "$(git status --porcelain)" ] || fail "verification changed tracked files"
git fetch origin master --quiet
git merge-base --is-ancestor origin/master "$candidate" \
  || fail "origin/master moved during verification; integrate it and retry"

log "local gates passed for exact candidate $candidate"
log "fast-forwarding origin/master directly; no GitHub Actions or pull request is involved"
git push origin "$candidate:refs/heads/master"
