## 1. Substrate Contract

- [x] 1.1 Write the canonical event-envelope gateway schema and validator.
- [x] 1.2 Add Postgres DDL for event streams, projection checkpoints, blobs, and sync imports.
- [x] 1.3 Add local JSON/SQLite-compatible fallback serialization using the same envelope.
- [x] 1.4 Split `stream_version`, `event_schema_version`, and `projection_version`.

## 2. Gateway Event Migration

- [x] 2.1 Mirror voice turns and provider-event summaries into the event substrate.
- [x] 2.2 Mirror chat turns and broker events into the event substrate.
- [x] 2.3 Mirror agent run lifecycle/events into the event substrate.
- [x] 2.4 Mirror browser tasks, tool requests, and receipts into the event substrate. Approval events are still pending.
- [x] 2.5 Mirror work-graph events/artifacts or link the existing Postgres work graph as a projection source.

## 3. Projections

- [ ] 3.1 Build projections for latest sessions, branches, turns, runs, tasks, approvals, receipts, and profile state.
- [ ] 3.2 Add projection checkpointing and rebuild tests.
- [ ] 3.3 Keep current gateway query APIs backed by projections so Android and browser clients do not churn.

## 4. Durable Execution

- [ ] 4.1 Spike Graphile Worker for queue/retry and Absurd, DBOS, or a minimal Postgres checkpoint table for step-level resume against one agent/tool execution.
- [ ] 4.2 Choose the smallest checkpointing path and document why.
- [ ] 4.3 Add restart/resume smoke coverage proving no duplicate side-effect events.

## 5. CRDT Object Layer

- [ ] 5.1 Choose the first CRDT-backed object type.
- [ ] 5.2 Add Loro snapshot/update persistence linked from event `crdt_refs`.
- [ ] 5.3 Add merge validation with authority metadata and losing-edit preservation.

## 6. Export, Import, And Sync

- [ ] 6.1 Add archive export for events, projection snapshots, blob refs, and CRDT updates.
- [ ] 6.2 Add idempotent import into a fresh local gateway.
- [ ] 6.3 Spike PowerSync against the event/projection tables before writing custom hosted/local sync.
- [ ] 6.4 Compare Electric and Zero only if PowerSync fails Android/browser/local fallback constraints.
- [ ] 6.5 Add per-origin local import checkpoints for optional hosted/local synchronization.
- [ ] 6.6 Add smoke coverage: hosted export -> local import -> projection rebuild.

## 7. Auth Modes

- [ ] 7.1 Define local no-auth mode, remote single-user mode, and hosted multi-tenant mode.
- [ ] 7.2 Gate export/import/sync APIs by auth mode without changing the storage contract.
- [ ] 7.3 Document how a user migrates from hosted to self-hosted and back.

## 8. Verification

- [x] 8.1 Gateway: `cd gateway && npm run check`.
- [x] 8.2 Gateway smoke: event append/query and idempotency. Projection rebuild/import smoke is still pending.
- [ ] 8.3 Android receipt sync: `cd android_app && ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew assembleDebug`.
- [ ] 8.4 Browser receipt sync: `cd browser_extension && npm run verify && npm run smoke`.
- [ ] 8.5 Deploy changed surfaces with `bash scripts/deploy.sh auto` after implementation commits.
