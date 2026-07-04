## Why

Chief Moa needs hosted operation without creating data lock-in. A user should be
able to use a hosted gateway, export or replicate their durable data, run the
same gateway on a personal machine or VPS, and optionally synchronize selected
records across both.

The existing gateway already stores voice turns, chat turns, runs, browser
tasks, tool requests, provider events, profile history, and work-graph records,
but these records are split across JSON/JSONL files plus a Postgres work-graph
adapter. The older Moa Bear planning and code points to the right substrate:
an append-only event log for audit/search/causality, projections for current
views, and CRDT documents only where concurrent mutable state needs merges.

## What

- Define a self-hostable event substrate for sessions, turns, profile changes,
  agent runs, browser tasks, tool requests, approvals, receipts, provider
  events, memory facts, and work artifacts.
- Keep Postgres as the hosted/VPS production store while preserving a no-auth,
  local-friendly mode for a personal machine.
- Add a portable event-envelope contract with origin ids, stream ids,
  idempotency keys, causation/correlation ids, actor/device metadata, authority
  metadata, and schema versions.
- Separate domain events from durable execution checkpoints. Long-running
  workflows may use a DBOS/Absurd-style Postgres checkpoint layer, but that
  layer does not replace the canonical product event log.
- Use CRDTs only for object types that actually need concurrent mutable merge,
  such as generated UI specs, shared flow/layout state, selected profile/config
  maps, and long-form collaborative text or graph objects.
- Define export/import and optional sync as protocol features over event
  segments, snapshots, blobs, and projection rebuilds.

## Non-Goals

- Do not introduce Temporal as the core runtime. It is too large for this
  product stage.
- Do not move Android or browser local authority into the gateway. Devices still
  claim, validate, execute, and receipt local actions.
- Do not make CRDTs the storage engine for every record. Most Moa data is
  append-only and should stay event-sourced.
- Do not require auth for a loopback/local-only personal gateway. Auth is for
  hosted, shared, remote, or cross-device access.

## Impact

- Gateway storage and APIs get a stable migration target.
- Android and browser clients can keep local outboxes and receipt logs without
  changing the trust boundary.
- Hosted and self-hosted deployments can use the same data model.
- Future agents can query current state through projections instead of scraping
  chat logs or provider memory.
