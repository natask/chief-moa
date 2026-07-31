# Master convergence audit — 2026-07-31

## Objective

Return Chief Moa to one working checkout and one active delivery candidate
without losing historical Git objects or reintroducing obsolete branch trees.
Move the verified candidate to `master` only through the repository's guarded
release path.

## Starting state

- `origin/master`: `2b986f92`.
- Primary branch: `feat/android-launcher-dictation-20260730`.
- Registered worktrees: 116.
- Local branches: 203 before the first merged and obsolete refs were removed.
- Remote branches: 77 including `origin/HEAD`.
- Open pull requests: seven.
- The primary candidate contained ten clean Android, gateway, deployment, and
  product-record commits ahead of `origin/master`.

## Preserved and integrated work

The primary candidate passed:

```sh
cd android_app
ANDROID_HOME="$HOME/Library/Android/sdk" \
  ./gradlew lintDebug assembleDebug testDebugUnitTest

cd gateway
npm run check
```

One dirty side-panel checkout held a real browser history-polish unit. Browser
verification and the real headless-Chrome smoke passed. Its resulting source
tree was already present in the primary candidate; the remaining release
version and branch history were integrated there.

Four other dirty worktrees were classified as non-product residue and removed:

- an untracked generated browser `package-lock.json`;
- a stopped daily-intention-loop merge ledger on a WIP branch;
- a conflict-marker cleanup in an explicitly abandoned userscripts integration;
- a comment-only edit on a superseded direct-master-push experiment.

No provider credentials or `.env` files were read.

## Historical branch closure

All remaining linked worktrees were clean and unused. Their branch refs were
preserved while the execution directories were removed, deepest path first.
The repository now has one registered worktree: the primary checkout.

Before deleting obsolete refs, the complete ref graph was saved and verified:

```text
.git/chief-moa-worktree-archive/pre-convergence-20260731.bundle
```

The bundle is 106 MB and contains 289 refs. A no-tree-change `ours` merge makes
every non-system local and remote historical branch tip reachable from the
primary candidate. This records superseded history without replacing the
current verified source tree with stale WIP or release candidates.

After that archive merge:

- all non-Entire local development branches except `master` and the active
  candidate were deleted;
- 73 obsolete remote branches were deleted;
- their stale pull requests closed with their deleted heads;
- remote refs now consist only of `master`, `vps-deploy`, and the active
  candidate, plus `origin/HEAD`;
- local `entire/*` refs remain because they are session-linkage metadata, not
  development worktrees.

## Promotion blocker

`scripts/release/push-master.sh` opened PR #114 and correctly refused to move
`master`. Every GitHub Actions job ended before acquiring a runner. The check
annotations report:

```text
The job was not started because recent account payments have failed or your
spending limit needs to be increased.
```

Local verification is green, but the repository contract does not permit a
direct push around the missing branch-side CI proof. Restore GitHub Actions
billing or spending capacity, rerun PR #114, then let
`scripts/release/push-master.sh` fast-forward `master` and prove the exact live
gateway commit. Only after that promotion should the active candidate branch be
deleted and the primary checkout switch to `master`.

