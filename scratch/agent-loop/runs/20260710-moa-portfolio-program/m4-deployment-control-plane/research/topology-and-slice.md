# Research packet: topology and slice decision

Date: 2026-07-10

## Repository topology

- `gateway/lib/work-history.js` already owns durable queued-run, claim, control,
  verification, deployment-request, and deployment-record event models.
- `gateway/server.js` exposes `work-history` HTTP routes and voice intent
  handling, so a new state machine should land behind the existing store first.
- `gateway/scripts/smoke-work-history-intent.js` and
  `gateway/scripts/smoke-work-history.js` already exercise deterministic
  proposal/query behavior through JSONL-backed product events.
- `gateway/lib/worker-pull.js` proves adjacent claim/lease patterns, but its
  agent-run queue is a separate lane and should not be conflated with deployment
  promotion authority in this slice.

## Five read-only passes

- Topology: existing deployment behavior is record-only; there is no typed
  review/claim/apply/rollback lifecycle yet.
- Trust/data: the gateway must remain a proposal recorder; no shell strings,
  raw credentials, or hidden apply authority may enter work-history records.
- Failure/recovery: current deployment records cannot model crash-after-effect,
  stale claim, duplicate apply, or rollback receipt as first-class events.
- Quality/gates: the smallest coherent unit is store-level plus deterministic
  smoke/unit coverage; server routes can stay thin wrappers.
- Current local facts: `codex` is installed, the current tree is already an
  isolated worktree, and gateway verification entrypoints are `node --test`,
  `npm run check`, `npm run smoke:work-history-intent`, and
  `npm run smoke:work-history`.

## Slice choice

Build a typed deployment-control sub-state inside `work-history` that sits
between existing `deployment.requested` and `deployment.recorded` events:

1. proposal/review state with target, artifact provenance, and preview intent
2. preview availability plus verification evidence
3. worker claim with lease/claim identity
4. guarded apply gate that requires preview + verification + backup/restore +
   drain/compatibility evidence
5. immutable effect receipt and explicit rollback receipt

This preserves the existing event-sourced boundary and advances M4 without
needing live deploy infrastructure.

## Residual unknowns

- MF tenant scoping for future hosted multi-tenant deployment authority
- MT telemetry correlation for deployment receipts and audits
- real deploy-target drain/resume semantics and preview URLs per target
- whether future apply ownership belongs in `work-history` or a separate control
  plane once live deployment infrastructure arrives
