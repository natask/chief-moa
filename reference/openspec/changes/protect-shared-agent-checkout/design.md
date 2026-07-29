## Workspace Identity

The primary checkout is derived from Git's absolute common directory, not from
the session's current path. In a linked worktree, the common directory still
points to the primary checkout's `.git` directory. This lets one policy tell a
shared checkout from an isolated worktree without hard-coding a clone path.

## Enforcement Layers

The launch wrapper checks the workspace before starting `codex` or `claude`.
The primary checkout must be on `master`. An exception requires the exact
current branch and a non-empty user-request citation; generic environment flags
do not bypass the launch check. Accepted exceptions append a machine-local
receipt under the shared Git directory so the citation survives worktree
cleanup without becoming repository content.

Provider `PreToolUse` hooks deny known branch-changing Git commands when they
target the primary checkout. `SessionStart` and `PostToolUse` checks compare the
primary branch with `master`, covering sessions launched outside the wrapper
and commands that evade static inspection. Detection does not attempt an
automatic checkout because doing so could overwrite concurrent user work.

## Isolation Rule

Linked worktrees may switch and create branches normally. The shared primary
branch and commit therefore remain unchanged while Claude Code and Codex do
branch work. This policy protects checkout identity; ordinary user edits on
`master` remain possible.
