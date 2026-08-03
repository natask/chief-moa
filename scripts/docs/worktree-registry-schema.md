# Worktree registry schema

`scripts/worktree-registry.mjs` provides a read-only audit and a registry-only
reconciliation pass. Neither command checks out, resets, removes, prunes, or
archives a worktree. The existing `scripts/worktree-lifecycle.sh` remains the
only closure command.

## Storage

The default directory is in Git's shared common directory:

```text
<git-common-dir>/chief-moa-worktree-registry/
  events.jsonl
  index.json
```

`audit` reads Git, the closure ledger, and existing registry events without
writing anything. `reconcile` appends one `worktree.registry.reconciled` event
and atomically renames a complete temporary `index.json` into place. Linked
worktrees therefore share one projection, and a removed checkout cannot remove
the registry.

Run either view from any linked checkout:

```sh
node scripts/worktree-registry.mjs audit
node scripts/worktree-registry.mjs reconcile --json
```

## Event envelope

Every JSONL event uses schema version `1` and these common fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `schema_version` | integer | Registry event schema, currently `1` |
| `event_id` | string | Globally unique event identity |
| `event_type` | string | One event type below |
| `occurred_at` | RFC 3339 string | Time the evidence was recorded |

The reconciler emits `worktree.registry.reconciled`, with `target_ref`, exact
`target_sha`, `worktree_count`, and `conflict_count`.

The first slice only consumes claim evidence; it does not expose a claim-writing
command or hook gateway allocation. A future allocator may append:

```json
{"schema_version":1,"event_id":"evt_1","event_type":"worktree.claim.recorded","occurred_at":"2026-08-03T12:00:00Z","claim_id":"claim_1","worktree_path":"/absolute/worktree","branch":"refs/heads/feature","task_id":"S0.3","candidate_id":"candidate_1","path_claims":["scripts/worktree-registry.mjs"]}
```

A later `worktree.claim.released` event names the same `claim_id`. The latest
recorded claim remains active until released. Relative path claims are
repository-root paths; directory claims overlap their descendants.

## Generated index

`index.json` contains:

- exact generation time and integration target ref/SHA;
- every Git-registered worktree with path, branch, HEAD, primary/prunable/bare,
  existence, dirty state, and integration state;
- task, candidate, and claimed-path identities only where durable claim events
  provide that evidence;
- lifecycle state: `active`, `closable`, `blocked`, or `idle-on-master`;
- reverse indexes from branch and claimed path to worktree paths;
- duplicate live branches, overlapping active path claims, orphan claims,
  prunable/missing registrations, closure receipts, and parse warnings.

A clean non-primary worktree is `closable` only when its HEAD is contained in or
patch-equivalent to the selected target. Duplicate claims, orphan registrations,
or a closure receipt matching a still-live worktree fail closed as `blocked`.
The index never infers a task or candidate identity from a directory or branch
name.
