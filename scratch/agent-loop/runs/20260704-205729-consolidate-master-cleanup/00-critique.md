# Critique

## Contradictions

- "Delete all sprawl" can conflict with "do not lose user work" if worktrees
  contain untracked files or branch-only commits.
- "Everything on master" can mean local only or remote too. Treat it as both,
  but do not deploy.
- Branch graph ancestry can be misleading after cherry-picks; patch equivalence
  matters as much as `git branch --merged`.

## Missing Primitives

- A branch/worktree inventory with dirty status.
- A preservation rule for untracked files.
- A verification gate before cleanup.
- A record of deleted/kept branches and why.
- A future workflow that prevents large unmanaged worktree batches from
  accumulating again.

## Smallest Viable Loop

1. Inventory every worktree and branch.
2. Commit or explicitly classify every dirty/untracked file.
3. Prove remaining branch tips are merged, patch-equivalent, or intentionally
   retained.
4. Push verified `master`.
5. Remove stale worktrees and local branches.
6. Record final state and the next operating rule.
