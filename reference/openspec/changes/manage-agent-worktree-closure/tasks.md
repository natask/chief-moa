## 1. Closure Contract

- [x] 1.1 Separate task state from worktree existence.
- [x] 1.2 Define evidence required for safe automatic closure.
- [x] 1.3 Preserve branches, dirty work, unique commits, primary checkouts, and
      worktrees currently used by a running process.

## 2. Audit And Archive Tool

- [x] 2.1 Add a read-only default audit command.
- [x] 2.2 Add an explicit dry-run archive command.
- [x] 2.3 Record exact closure evidence before removing safe worktrees.
- [x] 2.4 Verify the script against the current repository inventory.
- [x] 2.5 Archive only current safe worktrees and recount the remaining set.

## 3. Integration And Promotion

- [ ] 3.1 Commit the workflow unit with a Conventional Commit.
- [ ] 3.2 Integrate through `scripts/release/push-master.sh`.
- [ ] 3.3 Confirm remote master and deployment refs after promotion.
