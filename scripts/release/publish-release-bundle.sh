#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

fail() { echo "[publish-release-bundle] ERROR: $*" >&2; exit 1; }

[ "$#" -eq 1 ] || fail "usage: scripts/release/publish-release-bundle.sh <publication-manifest.json>"
[ -n "${MOA_COMPOSE_ENV_FILE:-}" ] || fail "MOA_COMPOSE_ENV_FILE is required"
[ -f "$MOA_COMPOSE_ENV_FILE" ] || fail "MOA_COMPOSE_ENV_FILE must name a readable file"
[ -n "${MOA_REPOSITORY_RELEASE_AUTHORITY_ID:-}" ] || fail "MOA_REPOSITORY_RELEASE_AUTHORITY_ID is required"
[ -n "${MOA_REPOSITORY_RELEASE_GIT_SHA:-}" ] || fail "MOA_REPOSITORY_RELEASE_GIT_SHA is required"
[ -n "${MOA_REPOSITORY_RELEASE_SOURCE_REF:-}" ] || fail "MOA_REPOSITORY_RELEASE_SOURCE_REF is required"
[ -n "${MOA_REPOSITORY_RELEASE_CHANNELS:-}" ] || fail "MOA_REPOSITORY_RELEASE_CHANNELS is required"

manifest="${1#./}"
case "$manifest" in
  ""|/*|..|../*|*/../*|*/..) fail "manifest must be a repo-relative path" ;;
esac
[ -f "$manifest" ] && [ ! -L "$manifest" ] \
  || fail "manifest must be a regular non-symlink file"
git ls-files --error-unmatch -- "$manifest" >/dev/null 2>&1 \
  || fail "manifest must be tracked by Git"

export RELEASE_PUBLICATION_MANIFEST="$manifest"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-chief-moa}"

docker compose \
  -p "$COMPOSE_PROJECT" \
  -f docker-compose.yml \
  --env-file "$MOA_COMPOSE_ENV_FILE" \
  --profile release-admin \
  run --rm release-publisher
