## 1. Thread store + branch lifecycle

- [x] 1.1 Add `lib/thread-store.js`: per-session branch metadata, active-thread
      pointer, rolling summaries, fork/new/incognito branch-id minting.
- [x] 1.2 Add `GET /v1/threads`, `POST /v1/threads/switch`, `GET /v1/threads/active`.
- [x] 1.3 Fix `sessionSummaryPayload` to merge chat + voice + browser sources
      (broker keeps the voice-only source).
- [x] 1.4 `scripts/smoke-threads.js` covering merge fix, switch, active, fork point.

## 2. context_management tool + guardrails

- [x] 2.1 Add `lib/context-decision.js`: deterministic prior + double-gate resolver.
- [x] 2.2 Force `context_management` in a context-free decision preflight on the
      chat and cascaded voice paths, then start a fresh scoped answer request
      without the decision tool.
- [x] 2.3 Resolve the filing thread (continue/new/fork/incognito) and store the
      decision as a record + `context.decision.recorded` product event.
- [x] 2.4 Return a bounded `context` block on both paths.
- [x] 2.5 `scripts/smoke-context-decision.js` (golden table + wired chat path).
- [x] 2.6 Plan filing identity/fork cutoff without durable mutation, commit the
      exact plan only after answer success, and replay completed chat/cascaded
      turn ids before preflight.

## 3. Enrichment + rolling summaries

- [x] 3.1 Add the bounded semantic recall block (thread summaries + intent
      memories) on the chat and cascaded voice paths.
- [x] 3.2 Add fork-point inheritance in `durableSessionContextBlock`.
- [x] 3.3 Add rolling per-thread summaries, regenerated asynchronously on a
      cadence and on switch-away, seeded from the parent on fork, indexed into
      gbrain under `moa/memory/thread/*`.
- [x] 3.4 `scripts/smoke-thread-enrichment.js` (recall block + bound, cadence
      summary + gbrain index, fork inheritance).
- [x] 3.5 Add a canonical context artifact envelope with version/cache identity,
      ranking rationale, redaction metadata, and a bounded response receipt for
      chat and cascaded voice retrieval.

## 4. Incognito persistence skips

- [x] 4.1 Skip turn files, ledger lines, product events, gbrain writes on the
      chat, HTTP voice, and streaming paths for an `inc-` branch.
- [x] 4.2 Delete the buffered PCM archive for an incognito streaming turn.
- [x] 4.3 `scripts/smoke-incognito.js` invariants (control persists, incognito
      persists nothing, standing facts still read, PCM deleted).

## 5. Docs

- [x] 5.1 Update `ARCHITECTURE.md` (voice chat + product primitives, the
      incognito carve-out, the context_management tool, enrichment blocks).
- [x] 5.2 Add this OpenSpec change.

## 6. Verification / deploy

- [x] 6.1 `cd gateway && npm run check` green.
- [ ] 6.2 Deployment is blocked until the user explicitly approves promotion.
- [ ] 6.3 Android History now exposes the active branch and one explicit fork
      action. Full thread switching, labels, incognito receipt UI, and browser
      parity remain later client work.
