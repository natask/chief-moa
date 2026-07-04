# Adoption Research

## Consultation Result

Gemini completed the dual-consult pass. Claude Code failed authentication with:

```text
Failed to authenticate. API Error: 401 Invalid authentication credentials
```

The consult doctor confirmed the Claude CLI is installed and current, and the
live smoke confirmed Gemini works while Claude auth fails. This is an account
credential blocker, not a prompt or model-selection issue.

## Gemini Recommendation

Gemini did not find a single end-to-end product. Its recommended composition:

- Postgres as the gateway source database and append-only event store.
- PowerSync for Postgres-to-client-SQLite sync.
- Loro for mutable CRDT-backed objects.
- Graphile Worker for simple Postgres-backed job queues.
- DBOS or Absurd-style durability only where step-level checkpoint/resume is
  needed.

Gemini explicitly rejected Temporal, Kafka, and EventStoreDB/KurrentDB for this
stage as too much operational burden for the self-hosted/personal-machine goal.
It also rejected CouchDB/PouchDB as an awkward fit for relational query and
agent metadata needs, and Firebase/Supabase-as-platform as poor fits for
portable self-hosting.

## External Source Check

PowerSync is the strongest sync candidate. Its docs describe a service plus
client SDKs that sync a backend database into in-app SQLite, queue local writes,
support offline usage, and allow self-hosting. It is server-authoritative, so
Chief Moa still needs explicit device authority and receipt semantics.

Electric is a strong read-path Postgres sync engine. Its docs describe Shapes
streamed from Postgres over HTTP while writes go through the existing backend.
That maps well to live read models, but it does not remove the need for a
write/outbox path.

Zero is strong for web-style client-first apps with server-authoritative
mutators over normal Postgres. It is less obviously a fit for Android native
receipt/outbox behavior than PowerSync.

Triplit and Jazz are more complete local-first database/framework options. They
may reduce custom work in a greenfield TypeScript app, but adopting either would
replace too much of Chief Moa's current gateway/Postgres/client authority shape.

Convex is now self-hostable and strong as an application backend, but adopting
it would mean changing the backend platform rather than adding a sync layer.

CouchDB/PouchDB is the mature offline replication reference and remains useful
prior art, but it would force a JSON document/replication model onto a product
that already needs Postgres, relational projections, provider/tool/run queries,
and selective CRDT blobs.

KurrentDB/EventStoreDB is the mature event-store reference. It provides native
streams, ordering, subscriptions, projections, and concurrency control, but adds
another operational database. For Chief Moa, Postgres is already required for
hosted/VPS storage and is sufficient for the current event volume.

Graphile Worker is a strong queue/retry candidate because it stores jobs in
Postgres, runs in Node, retries automatically, supports dedupe keys, and can run
inside the same Node process as the gateway. It is not a full durable execution
checkpoint system.

DBOS and Absurd are stronger fits for true durable execution because they
checkpoint workflow/step outputs in Postgres. They should be evaluated only for
work that must resume at a completed step instead of retrying the job from the
beginning.

Loro remains the best CRDT candidate because the Moa Bear code already validated
Loro document snapshots, incremental updates, import/merge, version vectors,
undo/redo, and browser/mobile WASM packaging.

## Recommendation

Do not maintain a custom network sync protocol unless PowerSync fails a focused
spike.

Keep the custom part small and unavoidable:

1. The event envelope and trust boundary are Chief Moa-specific.
2. The action proposal, device claim, local validation, approval, and receipt
   model are Chief Moa-specific.
3. Authority-aware merge is Chief Moa-specific.

Adopt everything else where practical:

1. Postgres for canonical hosted/VPS storage.
2. PowerSync for Android/browser local SQLite sync after the event tables exist.
3. Loro for only the mutable objects that need CRDT merge.
4. Graphile Worker for queues and retries.
5. DBOS or Absurd for checkpointed long-running executions only if Graphile
   Worker retry semantics are insufficient.

## First Spike

The first adoption spike should not start on Android. It should use one gateway
event table and one client SQLite replica:

1. Create the canonical event/projection tables in Postgres.
2. Connect PowerSync to those tables.
3. Sync a small session/turn/receipt projection into a local SQLite client.
4. Queue a local receipt write and verify it lands in Postgres through the
   gateway-authorized upload path.
5. Rebuild projections from the event table after import.

If this works, Chief Moa avoids custom continuous sync while keeping its custom
event and device-authority contracts.
