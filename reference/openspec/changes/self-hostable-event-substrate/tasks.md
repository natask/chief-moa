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
      Next: implement reducers one aggregate at a time. Complete when every
      named projection rebuilds from the event log and matches fixture state.
- [ ] 3.2 Add projection checkpointing and rebuild tests. Next: persist reducer
      bounds and resume from a checkpoint. Complete when tests prove full and
      checkpointed rebuilds produce identical projections.
- [ ] 3.3 Keep current gateway query APIs backed by projections so Android and browser clients do not churn.
      Next: switch one read path at a time behind compatibility tests. Complete
      when all current query contract tests pass against projections.

## 4. Durable Execution

- [ ] 4.1 Spike Graphile Worker for queue/retry and Absurd, DBOS, or a minimal Postgres checkpoint table for step-level resume against one agent/tool execution.
      Next: complete 4.1b and 4.1c. Complete when one compared candidate resumes
      the bounded execution without duplicating its linked effect.
- [x] 4.1a Complete a DBOS primary-source architecture evaluation and an
      independent verification pass as research only. Evidence:
      [`dbos-evaluation-20260725.md`](dbos-evaluation-20260725.md).
- [ ] 4.1b Compare DBOS against Graphile Worker, Absurd, and a minimal Postgres
      checkpoint implementation using the same Chief Moa workload and rubric.
      Next action: evaluate restart semantics, side-effect idempotency,
      cancellation, operational burden, self-hosting, and licensing for each
      candidate. Completion evidence: a retained comparison identifies
      trade-offs and a bounded pilot candidate without treating research as
      implementation.
- [ ] 4.1c Run the bounded durable-execution pilot against one agent or tool
      execution. Next action: implement the smallest candidate that can
      checkpoint a completed step, interrupt the worker, and resume it.
      Completion evidence: a repeatable smoke records the interruption and
      recovery and proves the linked domain event or external side effect is
      not duplicated.
- [ ] 4.2 Choose the smallest checkpointing path and document why. Next: decide
      only after the comparison and pilot. Complete when a decision record
      traces the choice to measured results and rejected alternatives.
- [ ] 4.3 Add restart/resume smoke coverage proving no duplicate side-effect events.
      Next: automate the pilot interruption case. Complete when the repeatable
      smoke passes across a real process restart and asserts one linked effect.

## 5. CRDT Object Layer

- [ ] 5.1 Choose the first CRDT-backed object type. Next: compare the listed
      mutable object candidates against actual concurrent-edit needs. Complete
      when a decision record selects one bounded proof and rejects append-only
      objects.
- [ ] 5.2 Add Loro snapshot/update persistence linked from event `crdt_refs`.
      Next: implement persistence for the selected object. Complete when export,
      import, and replay resolve the same document state from retained refs.
- [ ] 5.3 Add merge validation with authority metadata and losing-edit preservation.
      Next: add conflicting-writer fixtures. Complete when tests prove authority
      ordering and retain the losing edit as inspectable evidence.

## 6. Export, Import, And Sync

- [ ] 6.1 Add archive export for events, projection snapshots, blob refs, and CRDT updates.
      Next: define and emit a versioned manifest. Complete when counts, bounds,
      and digests verify for every included record class.
- [ ] 6.2 Add idempotent import into a fresh local gateway. Next: implement
      manifest validation and same-ID replay. Complete when importing the same
      archive twice yields one identical state.
- [ ] 6.3 Spike PowerSync against the event/projection tables before writing custom hosted/local sync.
      Next: sync one projection and upload one authorized receipt. Complete when
      an offline/online smoke preserves identity and gateway authority.
- [ ] 6.4 Compare Electric and Zero only if PowerSync fails Android/browser/local fallback constraints.
      Next: record the failed PowerSync constraint before starting alternatives.
      Complete when either PowerSync passes and this task is closed as
      unnecessary, or an equal-scope comparison selects a fallback.
- [ ] 6.5 Add per-origin local import checkpoints for optional hosted/local synchronization.
      Next: persist imported origin bounds. Complete when interrupted import
      resumes without omission or duplication.
- [ ] 6.6 Add smoke coverage: hosted export -> local import -> projection rebuild.
      Next: automate the full archive round trip. Complete when rebuilt core
      projections match source counts and digests.

## 7. Auth Modes

- [ ] 7.1 Define local no-auth mode, remote single-user mode, and hosted multi-tenant mode.
      Next: specify bind, identity, and authorization rules per mode. Complete
      when threat-model examples cover every mode and forbidden combination.
- [ ] 7.2 Gate export/import/sync APIs by auth mode without changing the storage contract.
      Next: add policy checks above the shared store. Complete when positive and
      negative route tests pass for all three modes.
- [ ] 7.3 Document how a user migrates from hosted to self-hosted and back.
      Next: write export, transfer, import, verification, and rollback steps.
      Complete when a dry run reconstructs core projections in each direction.

## 8. Verification

- [x] 8.1 Gateway: `cd gateway && npm run check`.
- [x] 8.2 Gateway smoke: event append/query and idempotency. Projection rebuild/import smoke is still pending.
- [ ] 8.3 Android receipt sync: `cd android_app && ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew assembleDebug`.
      Next: implement the Android receipt-sync slice and run the command.
      Complete when the build passes and a receipt round-trip is retained.
- [ ] 8.4 Browser receipt sync: `cd browser_extension && npm run verify && npm run smoke`.
      Next: implement the browser receipt-sync slice and run both commands.
      Complete when verification and a receipt round-trip smoke pass.
- [ ] 8.5 Deploy changed surfaces with `bash scripts/deploy.sh auto` after implementation commits.
      Next: after committed deployable work passes preview and promotion gates,
      run the deployment path. Complete when exact artifacts have deployment
      and post-deploy smoke receipts, or the task records an explicit gate
      blocker without claiming deployment.
