# OpenSpec: Master Consolidation Cleanup

## Problem

The repository accumulated many local worktrees and branches from parallel
agent work. The project needs one clean mainline, no hidden useful work outside
`master`, and a repeatable planning/execution loop so future work does not turn
into unmanaged sprawl again.

## User-Control Boundary

The agent may commit local cleanup artifacts, push `master`, remove local
worktrees, and delete local branches after verifying their work is already on
`master` or patch-equivalent. The agent must not deploy, restart services,
install timers, run migrations, mutate live data, or read secret files.

## Non-Goals

- No active service promotion or deployment.
- No remote branch deletion unless separately requested.
- No destructive cleanup before preserving dirty work.

## Primitives

- intent artifact
- critique artifact
- ticket ledger
- branch/worktree inventory
- preservation rule
- verification evidence
- feedback intake

## Acceptance Criteria

- Local checkout is on `master`.
- `master` contains all useful local commits and is pushed to `origin/master`.
- Every removed worktree has no unpreserved dirty work.
- Every removed branch is merged or patch-equivalent to `master`.
- Any remaining branch/worktree is listed with a reason.
- Verification commands and cleanup actions are recorded.

## Verification

- `git status --short --branch`
- `git worktree list --porcelain`
- `git branch --no-merged master`
- `git cherry -v master <branch>` for patch-equivalence checks
- `cd gateway && npm run check`
- `fabro validate .fabro/workflows/master-consolidation-cleanup/workflow.fabro`

## Failure Modes

- Untracked generated files block worktree removal; capture them or remove only
  after identifying them as generated junk.
- `origin/master` moves during cleanup; fetch and rebase/merge consciously
  before pushing.
- Branch deletion hides useful work; delete only after merge or
  patch-equivalence is proven.
