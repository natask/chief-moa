#!/usr/bin/env bash
set -euo pipefail

# Print the next unique browser-extension version.
#
# Version numbers are allocated by hand across parallel branches, which
# collides (two branches both picking 0.1.32). This scans the manifest on
# EVERY origin ref plus the local HEAD, takes the highest semver, and bumps
# the patch — so any branch asking for "next" gets a globally unused number.
#
# Usage: scripts/release/next-extension-version.sh   # prints e.g. 0.1.38

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MANIFEST_PATH="browser_extension/extension/manifest.json"

cd "$ROOT_DIR"
git fetch origin --quiet || true

refs="$(git for-each-ref --format='%(refname)' refs/remotes/origin refs/heads)"

versions=""
for ref in $refs HEAD; do
  v="$(git show "${ref}:${MANIFEST_PATH}" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{console.log(JSON.parse(s).version||"")}catch{}})' \
    || true)"
  [ -n "$v" ] && versions="${versions}${v}\n"
done

highest="$(printf "%b" "$versions" | sort -uV | tail -1)"
if [ -z "$highest" ]; then
  echo "could not read any manifest version from git refs" >&2
  exit 1
fi

IFS=. read -r major minor patch <<<"$highest"
echo "${major}.${minor}.$((patch + 1))"
