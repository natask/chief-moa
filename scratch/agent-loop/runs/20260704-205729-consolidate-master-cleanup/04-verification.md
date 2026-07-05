# Verification

Final checks run from the main checkout:

- `cd gateway && npm run check` -> passed.
- `cd browser_extension && npm run verify` -> passed.
- `cd browser_extension && npm run smoke` -> passed.
- `cd android_app && ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew assembleDebug` -> passed.
- `bash -n scripts/deploy.sh` -> passed.
- stale path scans for `software/moa_gateway`, `software/android_app`,
  `software/browser_extension`, and non-`reference/openspec/changes` active
  refs -> clean.
- `git worktree list --porcelain` -> only the main checkout remains.
- `git branch -vv` -> only `master`.
- `git branch -r` -> only `origin/HEAD` and `origin/master`.
- `entire clean --all --dry-run` -> no items to clean.

Deployment was not run because live-app promotion requires explicit user
approval in the current turn plus the backup/restore gate.
