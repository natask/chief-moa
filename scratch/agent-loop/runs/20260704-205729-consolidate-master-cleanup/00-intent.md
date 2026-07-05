# Intent

Raw user goal: make sure everything useful from the current chief-moa branch and
worktree sprawl is on `master`, commit or manage every worktree, clean up
unnecessary worktrees and branches, and leave a real mechanism for planning,
building, and executing future work.

Observable success:

- This checkout is on `master`.
- Useful local work is committed on `master`.
- `master` is verified and pushed to `origin/master`.
- Stale worktrees and local branches are removed after their work is preserved or
  proven merged/patch-equivalent.
- Remaining non-removed worktrees, if any, are explicitly justified.
- The process is recorded in this run directory and a Fabro workflow exists for
  future cleanup/consolidation loops.

Explicit non-goals:

- No live app deployment, restart, migration, URL switch, LaunchAgent install,
  or active backup execution.
- No reading `.env` files or printing secrets.
- No deleting uncommitted user-authored work without first preserving it or
  proving it is generated junk.

Target repo: `/Users/natnaelkahssay/projs/chief-moa`.

Current uncertainty:

- Some old worktrees may contain untracked generated files.
- Some branches may be patch-equivalent to `master` but not graph-merged because
  their commits were cherry-picked.
- Remote `origin/master` may have advanced during consolidation, so pushing must
  verify current upstream state first.
