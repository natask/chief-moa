# Master convergence audit — 2026-07-28

## Objective

Converge completed work toward the current remote `master` without treating
worktree existence or a unique branch tip as proof that work is complete. Keep
all dirty and ambiguous user work recoverable, and make the primary checkout
the eventual long-lived development checkout.

## Inventory baseline

- Remote baseline: `origin/master` at
  `cfdb881b5cdf60a2f878fb02d282de3183b08d6b`.
- Local `master`: `f70977d24a94ef38fe9d62f5b9d3e33481df1c4c`, stale and checked
  out at `/Users/natnaelkahssay/scratch/chief-moa-short-repeat.ciOLQJ`.
- Local branches: 304.
- `origin` remote-tracking refs: 48.
- Registered worktrees: 157, including stale/prunable registrations.
- Dirty worktrees: 17.

The authoritative reproducible classification is:

```sh
git fetch --all --prune
bash scripts/worktree-lifecycle.sh audit --target-ref origin/master
```

That command names every registered worktree, exact branch or detached HEAD,
commit, path, dirty state, and whether the work is contained, patch-equivalent,
unique, in use, protected, or prunable. Branches without a registered worktree
remain preserved refs and can be inspected with:

```sh
git for-each-ref --sort=-committerdate \
  --format='%(committerdate:iso8601)%09%(refname:short)%09%(objectname)%09%(subject)' \
  refs/heads refs/remotes/origin
```

## Selected convergence line

`release/converge-master-20260728` points to
`b967b1f24d7fd8d55b80893d0ff26591156043c0`. It is an 11-commit linear line
directly on current `origin/master` and is the newest coherent integration of:

- lineage-safe Android publication checks;
- the Ag product identity and parallel-package migration contract;
- gateway device enrollment with hash-only scoped credentials;
- Android enrollment and continuity recovery;
- active-surface branding; and
- extraction of the Android onboarding controller below the source-size ceiling.

The following sibling tips are superseded by that selected line and must not be
merged independently:

- `feat/ag-active-brand-20260728`
- `feat/ag-enrollment-20260728`
- `feat/ag-android-enrollment-20260728`
- `feat/ag-android-onboarding-20260728`
- `fix/ag-source-size-20260728`

The selected line is verified but not approved for `master` promotion. It
changes the Android application id from `ai.moa.assistant` to `ag.companion`,
which is intentionally a parallel install rather than an OTA update. The active
OpenSpec still requires real-phone parallel-install/isolation QA, a complete
guided onboarding path, an isolated device-reachable preview, rollback and
no-interruption evidence, and exact-artifact installation/smoke receipts.

## Other recent unique candidates

These tips contain coherent-looking completed units but are not silently folded
into the package-migration candidate because each needs independent acceptance
and conflict verification against the selected line:

- `feat/master-conversation-surface-20260728`: history-first full-app Android
  home; three commits directly on the baseline.
- `feat/app-software-factory-m1-20260728`: Android feedback-to-fix lifecycle,
  emulator evidence lane, gateway coordination, and release-control changes;
  21 commits and a separate product milestone.
- `feat/master-compact-transcript-20260728`: copyable transcript variants; one
  commit based eight baseline commits behind current `origin/master`.
- `fix/android-overlay-polish-20260728`: overlay sizing/drag refinement; one
  commit based 25 baseline commits behind current `origin/master`.
- `feat/device-preview-delivery-20260723`: seven unique Android intent/voice
  commits on a branch 138 baseline commits behind; its audio and coordination
  work is represented by newer master-side commits, while its intent portfolio
  remains a separate review unit.

These are `candidate` or `experimental`, not “merge everything” inputs. Their
refs and worktrees are preserved.

## Already integrated or cleanup candidates

Worktrees classified `contained` or `patch-equivalent` by the lifecycle audit
are already represented by `origin/master` and are safe cleanup candidates only
when they are clean and not used by a running process. Registrations classified
`prunable` point at absent directories. No worktree or branch was removed in
this convergence pass. Use the repository's receipt-writing cleanup path, never
manual directory deletion:

```sh
bash scripts/worktree-lifecycle.sh archive-safe --target-ref origin/master
```

Review the dry run before adding `--execute`.

## Dirty or active blockers

The following worktrees have tracked or untracked state and must remain
untouched until their owners commit, preserve, or explicitly discard it:

- `feat/device-preview-delivery-20260723` — primary checkout
- `lane/browser-overlay-20260727`
- `integrate/overlay-redesign-20260727`
- `feat/daily-intent-loop-20260725`
- `integrate/browser-userscripts-20260716`
- `repair/voice-modes-server-size`
- `integrate/surface-local-extension-20260716`
- `hygiene/android-screen-draft-insertion-20260716`
- `hygiene/gateway-browser-program-core`
- `hygiene/gateway-video-evidence-continuation-core`
- `hygiene/macos-local-program-20260716`
- `hygiene/macos-screen-aware-ask-20260716`
- `hygiene/repair-event-substrate-coverage`
- `integrate/voice-geez-auto-prompt-20260716`
- `proj/chief-moa`
- `feat/codex-intent-launcher-adapter-20260725`
- `fix/mobile-voice-failure-20260726`

The lifecycle audit also marks several clean worktrees `in-use`; they are not
cleanup candidates while a process has them as its working directory.

## Verification evidence

Against `release/converge-master-20260728` at `b967b1f2`:

- Android: `ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew assembleDebug`
  passed.
- Browser extension: `npm run verify && npm run smoke` passed, including the
  real headless-extension smoke.
- Gateway: `npm ci && npm run check` passed. The first check before dependency
  installation failed only because the fresh worktree had no `ws`/`pg`
  dependencies; the installed-dependency rerun passed.

No preview was published and no active target was promoted. The package
migration lacks the required phone and rollout evidence, so
`scripts/release/push-master.sh` must not run yet.

## Primary checkout transition

The primary checkout cannot safely switch to `master` yet because it contains
the untracked overlay-redesign record and local `master` is checked out in a
different worktree. Safe transition requires:

1. preserve or commit the primary checkout's untracked record;
2. finish or release the stale local-master worktree without losing its state;
3. fast-forward local `master` to `origin/master` only after the selected
   convergence candidate passes its outstanding product/release gate; and
4. switch the primary checkout to `master`.

Future ordinary development can then use the primary `master` checkout, while
deploy isolation remains mandatory for gateway production work.
