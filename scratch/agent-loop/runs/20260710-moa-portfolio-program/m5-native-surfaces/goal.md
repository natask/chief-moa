# M5 goal — stable Aggie surface protocol

## Objective

Freeze and prove a provider-neutral, cross-platform Aggie session/event/action/
receipt protocol plus deterministic echo adapter and N/N-1 fixtures. The seam
must be safe for browser, Android and future native clients without creating a
second product database or letting server/model proposals execute locally.

## Lane

- Branch: `agent/m5-surface-protocol`
- Worktree: `/Users/natnaelkahssay/projs/chief-moa-worktrees/m5-surface-protocol`
- Base: `agent/voice-pipeline-orchestration` at `2a6a7d5`

## Owned paths

- `gateway/lib/aggie-surface-protocol.js`
- `gateway/test/aggie-surface-protocol.test.js`
- `gateway/scripts/smoke-aggie-surface-protocol.js`
- `reference/openspec/changes/define-aggie-compatible-surface/**`
- M5 workflow packet under this directory
- `ARCHITECTURE.md` only for the new protocol boundary

## Do not touch

- Existing identity, billing, telemetry, retrieval, deployment-control and
  provider-routing implementations
- Android/browser UX or local action executors
- Platform signing, installers, production credentials, live services

## Acceptance

1. Versioned typed envelopes cover hello/resume, turns, events, proposals,
   approvals and receipts with exact bounds.
2. Unknown additive fields are tolerated at N and N-1; unknown required
   semantics fail closed.
3. Replay/dedupe, stale-action and reconnect/backoff policy is deterministic.
4. Echo adapter emits a valid event sequence and artifact without external I/O.
5. Provider keys, raw executable code and unapproved local execution are
   structurally excluded.
6. Focused unit/smoke, full gateway check and strict OpenSpec validation pass.

## Live constraints

No live app interruption, signing, device installation or promotion. This lane
produces a committed source artifact only; native device evidence remains an
explicit unknown.
