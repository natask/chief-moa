## Lifecycle Model

Work moves through explicit states:

```text
captured -> active -> candidate -> verified -> integrated -> promoted -> archived
                  \-> blocked -------------------------------/
                  \-> superseded ----------------------------/
```

These states describe evidence, not directories. A worktree may materialize an
active, candidate, or verification state, but its presence cannot prove any of
them.

## Closure Rule

A worktree may be removed automatically only when all of these are true:

1. It is not the primary checkout or the checkout invoking cleanup.
2. No running process has that worktree, or a directory beneath it, as its
   current working directory.
3. Its tracked and untracked state is clean.
4. Its HEAD is an ancestor of the chosen promoted target, or every commit is
   patch-equivalent to changes already in that target.
5. The exact path, branch, HEAD, classification, target ref, target SHA, and
timestamp are written to the shared Git closure ledger first.

Cleanup never deletes branch refs. Dirty or unique candidates remain visible
for an explicit accept, supersede, or block decision. Repeated cleanup against
the same target is idempotent: an existing receipt for the same path, HEAD,
classification, and target SHA is not appended again.

## Operating Policy

- Default view: actionable states only (`active`, `blocked`, `candidate`, and
  `verified`); archived records are searchable but not shown as open work.
- One owner must decide integration. Parallel lanes may develop or verify, but
  may not independently push master.
- “Done” requires verification, commit, artifact/preview where deployable,
  promotion when safe, promoted smoke evidence, and closure.
- Raw voice and chat are inbox evidence. They must be split into durable intents
  rather than retained as one undifferentiated task.
- Preserve decisions and outcomes aggressively; preserve disposable execution
  environments only while they are needed.

## Tooling

`scripts/worktree-lifecycle.sh audit` classifies all worktrees. The
`archive-safe` command is a dry run unless `--execute` is supplied. Exact local
closure receipts live in the shared Git directory at
`chief-moa-worktree-archive/closures.tsv`, so removing a linked checkout does
not remove the record.
