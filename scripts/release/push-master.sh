#!/usr/bin/env bash
set -euo pipefail

# Deploy gate: master never receives an unverified commit.
#
# Pushing master IS the deploy trigger in this repo (vps-deploy ref + droplet
# timer; extension release; OTA build). This script makes "we don't fail
# deployments" a property instead of a discipline: it pushes the CURRENT
# branch, opens (or reuses) a PR so the same CI workflows run on the branch,
# waits for every check to go green, and only then fast-forwards master.
# A red run burns on the branch; the deploy ref never moves for it.
#
# Usage: scripts/release/push-master.sh
#   (run from the branch to release; requires gh auth and a clean tree)

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

fail() { echo "[push-master] ERROR: $*" >&2; exit 1; }
log() { echo "[push-master] $*"; }

branch="$(git branch --show-current)"
[ -n "$branch" ] || fail "detached HEAD; check out the branch to release"
[ "$branch" != "master" ] || fail "run from a feature branch, not master"
[ -z "$(git status --porcelain)" ] || fail "working tree is dirty; commit or set aside changes first"
command -v gh >/dev/null || fail "gh CLI is required"

git fetch origin master --quiet
git merge-base --is-ancestor origin/master HEAD \
  || fail "branch does not contain origin/master; rebase or merge master first so the push is a fast-forward"

# A repository commit is not necessarily a gateway deployment. The VPS workflow
# is path-filtered, so waiting for /health to report a new SHA after an Android,
# Apple, extension, or docs-only release can never succeed. Keep the exact-live
# check mandatory whenever this release actually touches the gateway deploy
# path.
gateway_deploy_changed=false
if ! git diff --quiet origin/master HEAD -- \
  .github/scripts/assert-deploy-vps-contract.rb \
  .github/workflows/deploy-vps.yml \
  gateway docker-compose.yml docker-compose.vps.yml scripts/vps; then
  gateway_deploy_changed=true
fi

# Mirror the extension release gate locally so the failure (if any) is instant
# instead of a CI round-trip: packaged source changes require a manifest bump.
if ! git diff --quiet origin/master HEAD -- browser_extension/extension; then
  current_version="$(node -p "require('./browser_extension/extension/manifest.json').version")"
  previous_version="$(git show origin/master:browser_extension/extension/manifest.json \
    | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>console.log(JSON.parse(s).version))')"
  if [ "$current_version" = "$previous_version" ]; then
    fail "extension sources changed but manifest version is still ${current_version}; run scripts/release/next-extension-version.sh and bump"
  fi
  log "extension version bump ok: ${previous_version} -> ${current_version}"
fi

log "pushing ${branch} to origin"
git push -u origin "$branch" --quiet

pr_number="$(gh pr list --head "$branch" --base master --state open --json number --jq '.[0].number' || true)"
if [ -z "$pr_number" ] || [ "$pr_number" = "null" ]; then
  log "opening release PR"
  gh pr create --base master --head "$branch" --fill >/dev/null
  pr_number="$(gh pr list --head "$branch" --base master --state open --json number --jq '.[0].number')"
fi
log "waiting for checks on PR #${pr_number} (branch-side CI: the same workflows master runs)"

# Does this diff touch any path that triggers a CI workflow? If yes, checks
# MUST appear — "no checks reported" right after PR creation is a scheduling
# race, not a green light. Only a diff outside every workflow path may proceed
# without checks.
expects_checks=false
if ! git diff --quiet origin/master HEAD -- \
  gateway docker-compose.yml docker-compose.vps.yml scripts/vps \
  browser_extension android_app apple_surfaces .github/workflows; then
  expects_checks=true
fi

if [ "$expects_checks" = true ]; then
  log "diff touches CI-verified paths; waiting for checks to be scheduled"
  deadline=$((SECONDS + 300))
  until [ "$(gh pr view "$pr_number" --json statusCheckRollup --jq '.statusCheckRollup | length' 2>/dev/null || echo 0)" -gt 0 ]; do
    [ "$SECONDS" -lt "$deadline" ] || fail "CI checks never appeared on PR #${pr_number} after 5 minutes; investigate before releasing. master was NOT moved."
    sleep 10
  done
fi

# --watch exits non-zero on any failed check.
if ! gh pr checks "$pr_number" --watch; then
  if [ "$expects_checks" = true ]; then
    gh pr checks "$pr_number" >&2 || true
    fail "branch CI is red; fix on the branch and rerun. master was NOT moved."
  fi
  log "no CI checks were triggered by this docs-only diff; continuing"
fi

git fetch origin master --quiet
git merge-base --is-ancestor origin/master HEAD \
  || fail "master moved while checks ran; rebase onto origin/master and rerun"

log "all checks green; fast-forwarding master (this starts the deploy)"
git push origin "HEAD:master"
released_sha="$(git rev-parse HEAD)"
log "master -> ${released_sha:0:12}. Deploy workflows now re-run on master against the identical tree."
if [ "$gateway_deploy_changed" = true ]; then
  log "gateway: droplet timer promotes within ~2 minutes of the vps-deploy ref moving."
  if ! bash scripts/vps/wait-for-live-commit.sh "$released_sha"; then
    fail "master and vps-deploy were published, but the active gateway did not prove the exact commit; inspect the droplet promotion receipt"
  fi
  log "gateway: exact live commit verified"
else
  log "gateway: deploy path unchanged; exact live-commit wait is not applicable"
fi
