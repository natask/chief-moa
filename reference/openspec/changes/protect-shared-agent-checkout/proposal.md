## Why

Claude Code and Codex sessions can share the primary ChiefMoa checkout. A
single session that switches this checkout changes the files and branch seen by
every other session, invalidates their assumptions, and can mix unrelated work.

## What Changes

- Define the primary ChiefMoa checkout as a protected shared workspace on
  `master`.
- Refuse provider launches in an invalid shared workspace unless the launcher
  carries an exact user-requested exception.
- Deny checkout-changing Git commands aimed at the shared workspace while
  leaving isolated linked worktrees available for branch work.
- Detect and report violations at session start and after shell tools.
- Prove the shared branch and commit stay stable across simulated Claude Code
  and Codex sessions.

## Outcome

Concurrent agents can work on branches without changing the foreground
checkout used by other sessions. A shared-checkout exception is visible and
specific instead of inferred from an agent's task.
