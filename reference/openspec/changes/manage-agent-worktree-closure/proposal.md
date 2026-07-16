## Why

Chief Moa accumulates worktrees faster than their completion state becomes
obvious. A worktree is only an execution directory, but it is being treated as
the durable memory of a task. That makes safe cleanup feel like information
loss and makes the list of directories a misleading substitute for the actual
active-work queue.

## What Changes

- Define explicit work states independently of Git worktree existence.
- Make worktree inspection read-only by default.
- Permit automatic closure only for clean execution directories whose commits
  are already contained in, or patch-equivalent to, the promoted target.
- Record exact closure evidence before removing a safe execution directory.
- Preserve dirty work, unique commits, branches, and the primary checkout.

## Outcome

The active list can stay small without sacrificing memory. Durable history is
carried by commits, refs, OpenSpec decisions, verification evidence, deployment
records, and closure receipts; disposable worktrees can be recreated from those
identities when needed.
