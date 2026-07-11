# M5 protocol implementation contract

## Exact objective and non-negotiables

Implement a pure CommonJS protocol module that normalizes and validates Aggie
surface messages for protocol versions 1 and 2, generates bounded reconnect
delays, tracks replay cursors/dedupe, and exposes a deterministic echo backend.
No network, storage, provider, UI, shell or device side effect belongs here.

## Interfaces

- `negotiateVersion(hello)` selects version 2 or 1 and fails closed otherwise.
- `validateEnvelope(value, options)` returns a deeply frozen canonical envelope.
- `createSessionReplay(options)` accepts events, dedupes and returns bounded
  replay/snapshot-required results.
- `reconnectDelay(attempt, entropy)` returns bounded full-jitter milliseconds.
- `createEchoAdapter()` implements metadata, health, sendTurn/startRun,
  resumeRun/cancelRun/listArtifacts as deterministic in-memory protocol output.
- `canExecuteProposal(proposal, context)` returns a typed allow/deny decision;
  it never executes.

## Protocol invariants

- Versions: current N=2, previous N-1=1; no downgrade below offered overlap.
- Every envelope: version, type, message_id, session_id, surface, timestamp.
- IDs use `[A-Za-z0-9._:-]`, 1–160 chars. Timestamps must parse.
- Unknown additive fields are ignored; unknown type/action/receipt status fails.
- Sequence is a safe positive integer for server events.
- Proposal expiry, approval class and state preconditions are mandatory.
- Receipt references proposal/message/session/surface, declares outcome and
  includes no secrets or unbounded detail.

## Forbidden shortcuts

No provider keys, model-selected executable strings, eval, shell, raw JS/CSS,
implicit action approval, unbounded arrays/strings, wall-clock-only dedupe,
global mutable tenant state, transport-specific protocol forks or mock claims
about live/native behavior.

## Targets and gates

- Complexity <=10 and CRAP <=15 for decision functions.
- Max envelope 64 KiB; replay 256 events/1 MiB; pending 128/512 KiB.
- `node --test test/aggie-surface-protocol.test.js`
- `node scripts/smoke-aggie-surface-protocol.js`
- `npm run check`
- strict OpenSpec validation if CLI resolves the referenced root.

## Audit blockers and escalation

Block on cross-session replay, proposal auto-execution, replay ambiguity,
secrets/executable payloads, unbounded resources, fake compatibility, provider
coupling or contradiction with existing identity/event authority. Escalate
permanent native UX, signing accounts, devices, public update infrastructure or
changes that require redefining canonical gateway identity/storage.
