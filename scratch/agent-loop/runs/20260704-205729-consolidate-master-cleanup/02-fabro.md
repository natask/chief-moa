# Fabro: Master Consolidation Cleanup

## Workflow

- path: `.fabro/workflows/master-consolidation-cleanup/workflow.fabro`
- goal: consolidate branch/worktree sprawl into verified `master` with no hidden
  local work
- gates: inventory, preserve, verify, cleanup
- artifacts: this run directory, git status outputs, verification results

## Tickets

| id | title | track | depends | acceptance | agent | verification |
| --- | --- | --- | --- | --- | --- | --- |
| T1 | Inventory branches and worktrees | workflow | none | all dirty worktrees and non-master branches listed | current | `git worktree list --porcelain` |
| T2 | Preserve useful loose work | workflow | T1 | no worktree has uncommitted useful work | current | `git status --short --branch` per worktree |
| T3 | Verify and push master | infra | T2 | `master` passes checks and matches `origin/master` | current | `cd gateway && npm run check` |
| T4 | Remove stale worktrees and branches | workflow | T3 | stale local worktrees/branches removed or justified | current | `git worktree list --porcelain`; `git branch --no-merged master` |

## Waves

| wave | tickets | rule |
| --- | --- | --- |
| 1 | T1 | read-only inventory |
| 2 | T2, T3 | preserve first, then verify/push |
| 3 | T4 | destructive cleanup only after verification |
