# Feedback

The repo is consolidated on `master` and the branch/worktree sprawl is cleaned.

What worked:

- Treat every non-main worktree as either useful work to land, generated noise
  to discard, or a branch to prove patch-equivalent before deletion.
- Keep OpenSpec/Fabro/run records on `master` so planning state survives branch
  cleanup.
- Use `git cherry master <branch>` before deleting cherry-picked branches.

Follow-up rule:

- Background subagents must run noninteractively. The hung read-only Codex
  review blocked cleanup until terminated because stdin was left open.
