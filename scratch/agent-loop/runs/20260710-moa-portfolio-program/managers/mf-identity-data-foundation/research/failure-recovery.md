# Failure and recovery pass

- Additive migrations are required; the current down migration is destructive
  and is rollback tooling only, not an allowed production rollback strategy.
- Old/new binaries must coexist while event tenant columns are backfilled.
- Import must remain idempotent and must never mutate its source directory.
- Deletion requires a resumable tombstone/job protocol across relational rows,
  events, blobs, caches and exports; none exists yet.
- Restore evidence in runbooks is operational documentation, not a fresh restore
  result for this branch.

No production migration or restore was run in this manager lane.
