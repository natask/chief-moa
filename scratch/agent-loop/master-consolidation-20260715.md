# Master Consolidation Plan — 2026-07-15

## Outcome

Consolidate all legitimate, unique Chief Moa product, specification, workflow,
and verification work onto current `origin/master`, validate the integrated
tree, push `master`, verify the repository release workflows and production
health, then prune worktrees and branches that no longer contain unique work.

## Inclusion Rule

Include work when it changes the product, architecture/specification, test or
verification contract, build/release path, or durable engineering workflow and
the resulting patch is not already present or superseded on master.

Do not merge these as product commits:

- `entire/*` session/checkpoint metadata refs;
- explicit `backup*` branches, which remain recovery refs until consolidation
  is proven;
- patch-equivalent duplicate commits already represented on master or the
  integration branch;
- untracked generated lockfiles that are not the package manager selected by
  that surface;
- dead worktree registrations whose directories no longer exist.

Exclusion is not deletion. A ref or worktree is pruned only after its unique
diff is empty against validated master or its remaining content is recorded as
intentionally superseded.

## Integration Shape

1. Refresh remotes and freeze an inventory of local branches and worktrees.
2. Commit legitimate dirty units on their owning branches after their narrow
   checks pass; do not mix unrelated worktree edits.
3. Create an isolated consolidation worktree and branch from current
   `origin/master`.
4. Integrate maximal branch tips first so shared histories enter once. Re-run
   `git cherry` after every lane and add only still-unique patches.
5. Resolve conflicts in favor of current master contracts unless the incoming
   work adds a tested capability or a newer accepted OpenSpec decision.
6. Run gateway, browser extension, Android, strict OpenSpec, and focused lane
   checks on the combined tree. Repair failures as separate Conventional
   Commits.
7. Fast-forward local `master` to the validated consolidation branch, push it,
   observe CI and release refs, and check `https://api.agee.app/health`.
8. Prune only merged/superseded worktrees and branches; retain backup and
   Entire metadata refs unless their owning system explicitly manages them.

## Initial Maximal Lanes

- voice/browser orchestration: `agent/voice-pipeline-orchestration` plus its
  committed userscript decision;
- intent/context: `agent/intent-runtime-20260711`, followed by any still-unique
  M3 hardening;
- semantic reduction: common reduction chain plus distinct browser smoke,
  gateway gate, and build-identity tips;
- persistent worker/preview/telemetry: the shared chain once, followed by
  preview and telemetry tips and their committed dirty repairs;
- voice diagnostics/product contract;
- independent UI-spec, companion/pet, profile, and pet-library patches;
- committed Android, browser, gateway voice-draft and continuity worktrees.

## Required Gate

The consolidation may reach `master` only after:

- `cd gateway && npm run check && npm run eval:voice`;
- `cd browser_extension && npm run verify && npm run smoke`;
- `cd android_app && ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew
  testDebugUnitTest assembleDebug`;
- every non-archived OpenSpec change intended to remain active validates with
  `openspec validate <change> --strict`, or is repaired/archived explicitly;
- `git diff --check` is clean and no target surface is dirty;
- rollback, state compatibility, backup/restore, and no-interruption evidence
  is available before any active promotion.

Paid provider and real phone/browser QA remain distinct evidence. They are not
silently inferred from deterministic checks.
