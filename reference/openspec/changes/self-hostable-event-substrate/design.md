## Context

The current architecture already says Postgres is the production gateway store
target and that DBOS-style durable execution should be considered for resumable
workflows and queues. The Moa Bear research and implementation add the missing
substrate decision: keep a complete append-only event log as the canonical
record, derive read models through projections, and use Loro/CRDT documents only
for mutable shared objects.

This change adapts that older local-first thinking to Chief Moa's current
hosted/self-hostable gateway boundary.

## Decisions

### Decision: Adopt Sync/Execution Components Where They Fit

The lowest-maintenance path is not a single platform replacement. It is a small
Postgres-centered composition:

- Postgres remains the gateway source database for hosted and VPS deployments.
- PowerSync is the leading candidate for client SQLite sync if Chief Moa needs
  offline Android/browser reads and writes without custom sync transport.
- Loro remains the leading CRDT candidate for mutable collaborative objects.
- Graphile Worker is the leading candidate for simple Postgres-backed job queues.
- DBOS or Absurd remains worth evaluating only when step-level checkpoint
  resume is required, because a job queue alone does not checkpoint arbitrary
  workflow steps.

Electric, Zero, Triplit, Jazz, Convex, CouchDB/PouchDB, and KurrentDB remain
serious references, but each would pull Chief Moa farther away from the current
gateway/Postgres/device-authority boundary than PowerSync plus selective Loro.

### Decision: Event Log Is The Product Substrate

The canonical product record is an append-only event log, not a pile of current
state tables and not provider conversation memory. Every important product
transition should be representable as a durable event:

- session, branch, turn, transcript, and provider event changes
- profile, language, voice, model, and device override changes
- agent run lifecycle and evidence attachment
- browser task, tool request, approval, execution, and receipt changes
- work-graph node events and durable artifacts
- import/export/sync lifecycle events

Optimized tables and files are projections. They exist to serve UI and queries,
but they must be rebuildable from events plus snapshots and blobs.

### Decision: Postgres First, Local Fallback Second

Hosted and VPS deployments use Postgres. A local personal gateway may keep a
no-auth file-backed fallback for development and single-user runs, but the
fallback follows the same event-envelope and export/import contract.

This keeps the hosted product easy to operate while preserving self-hostability.
It also avoids forcing every user to run a peer-to-peer database just to try the
assistant.

### Decision: Domain Events And Execution Checkpoints Are Separate

Domain events say what happened in the Moa product. Execution checkpoints let a
long-running task resume without repeating completed steps.

A DBOS/Absurd-style layer is a good fit for executions because it checkpoints
workflow steps in Postgres without a separate Temporal cluster. That layer
should power durable queues, tool runs, agent harness steps, sleeps, retries,
and waits. It should not become the product history database.

The relationship is:

```text
domain event log
  owns: durable product truth, audit, sync, replay, projections

durable execution store
  owns: task queue, claim/retry, step checkpoints, waits, resume/cancel

receipts
  own: local proof that a device/browser executed or rejected a proposal
```

Executions append domain events as they progress. A completed checkpoint can
prevent duplicate work, but the resulting user-visible state is still recorded
as domain events and receipts.

### Decision: CRDTs Are Selective

CRDTs are required only when the same mutable object can be edited offline or
concurrently by more than one writer. Most records do not need CRDT merge:
voice turns, action receipts, provider events, run events, and browser task
events are append-only.

Use CRDT documents for:

- generated UI specs and layout state
- shared flow/workspace documents
- selected config/profile maps where field-level merge matters
- long-form collaborative text
- graph-like memory objects where node/edge merge is useful

Loro is the strongest reuse candidate from Moa Bear because the codebase already
validated snapshot export, incremental update export, import/merge, version
vectors, undo, and browser/mobile WASM packaging. Yjs or Automerge remain
fallbacks for specific surfaces if runtime constraints make Loro unsuitable.

### Decision: Authority Metadata Travels With Events

Chief Moa needs authority-aware merge, not blind last-write-wins. Events and
CRDT operations should carry actor, device, scope, capability, parent run, and
authority metadata.

Initial ordering:

1. explicit user action wins over agent output
2. parent/supervising agent wins over child agent within delegated scope
3. scoped capability owner wins over same-level unscope writes
4. deterministic tie-breakers apply only after authority and scope are equal

Losing edits are not deleted. They are preserved as superseded or conflict
events so later agents and the user can inspect what happened.

### Decision: Sync Uses Event Segments, Snapshots, And Local Checkpoints

Sync should not be framed as "sync cursors" in product language. A checkpoint is
local bookkeeping: each replica records what it has already imported from each
origin.

The sync unit is:

- event segments: ordered events for an origin/stream/time range
- projection snapshots: optional acceleration points
- blob references: content-addressed audio, attachments, artifacts, CRDT updates
- CRDT updates: per-object snapshots or incrementals where the object type uses
  a CRDT

Import is idempotent by event id and idempotency key. Projection rebuilds are
allowed after import.

### Decision: Auth Depends On Deployment Mode

Local loopback mode can run without auth. Remote single-user and hosted modes
need auth. Hosted multi-tenant mode also needs tenant isolation and admin/user
roles.

The storage contract should not depend on auth mode. Auth decides who may append,
read, export, import, or sync; it does not change the event envelope.

## Event Envelope

The first stable event envelope should split overloaded version fields:

```json
{
  "event_id": "evt_...",
  "origin_id": "hosted-main | vps-1 | android-device-id | browser-install-id",
  "stream_id": "session:... | run:... | profile:global | receipt:device:...",
  "stream_version": 42,
  "event_type": "voice.turn.accepted",
  "event_schema_version": 1,
  "occurred_at": "2026-06-27T00:00:00.000Z",
  "recorded_at": "2026-06-27T00:00:00.100Z",
  "actor": {
    "kind": "user | agent | device | gateway | extension | system",
    "id": "..."
  },
  "authority": {
    "level": 0,
    "scope": "session:... | device:... | browser:tab:...",
    "parent_actor_id": null
  },
  "causation_id": "evt_...",
  "correlation_id": "corr_...",
  "idempotency_key": "client-turn-id-or-request-id",
  "payload": {},
  "blob_refs": [],
  "crdt_refs": [],
  "signature": null
}
```

Postgres should enforce uniqueness for `event_id`, `idempotency_key` where
present, and `(origin_id, stream_id, stream_version)`.

## Lane Split

### Gateway Substrate

Outcome: canonical event tables, append/query APIs, projection rebuild path, and
migration from JSON/JSONL ledgers.

Boundary: gateway owns storage, model/provider credentials, routing, durable
execution, and sync/export/import APIs.

Acceptance: a voice turn, provider event, agent run event, browser task receipt,
and work artifact can be appended as events and read back through projections.

### Durable Execution

Outcome: DBOS/Absurd-style checkpointing for long-running tool and agent
executions, backed by Postgres.

Boundary: checkpoints prevent duplicate step execution; domain events remain the
auditable product truth.

Acceptance: a simulated gateway restart resumes an interrupted execution from
the last completed step and does not duplicate the linked domain events.

### Android Action/Receipt Outbox

Outcome: Android keeps local action receipts and can sync receipt events upward
when connected.

Boundary: Android still validates proposals, owns approvals, executes local
accessibility/app actions, and records local receipts before optional gateway
sync.

Acceptance: a phone-local action creates a local receipt and the gateway imports
it as an idempotent receipt event.

### Browser Task/Receipt Outbox

Outcome: browser extension keeps local CDP task receipts and syncs them to the
gateway.

Boundary: browser extension still claims tasks and runs allowlisted
`chrome.debugger` actions locally.

Acceptance: a browser tab action creates one gateway task event, one claim
event, and one receipt event without the gateway running CDP.

### CRDT Object Layer

Outcome: define which objects use Loro/CRDT updates and how those updates are
referenced from domain events.

Boundary: CRDT merge handles mutable object state; event log handles audit,
causality, and projection triggers.

Acceptance: a generated UI/layout object can be exported, imported, merged, and
linked from event records.

### Export/Import/Sync

Outcome: portable archive and optional remote-to-local sync over event segments,
snapshots, blob refs, and CRDT updates.

Boundary: export/import is a user data right; continuous sync is optional.

Acceptance: a user can export hosted data, import it into a local gateway, and
rebuild core projections without provider memory.

## Open Questions

- Whether to embed Absurd directly, use DBOS, or implement the minimal
  checkpoint tables ourselves for the first execution slice.
- Whether mobile local storage should be SQLite immediately or start with the
  existing receipt/outbox structures and converge later.
- Which CRDT object should be the first production proof: UI spec/layout,
  profile/config map, or flow/workspace document.
- Which records need cryptographic signatures in V1 versus hashes and
  idempotency keys only.
