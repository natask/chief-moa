# Repair contract: browser final-audit-8 blockers

## Required fixes

1. Preserve the canonical local `voiceSessionId` returned by background before
   validating gateway-facing draft authority. If validation or attachment then
   fails, send one local `voiceSessionClose` for that exact ID and await its
   bounded disposal before retiring content state. Never use malformed returned
   draft/session/branch/turn authority for SEND or discard.
2. Route every pre-admission exit through one idempotent async disposer:
   unregister authority first, close the socket, truthfully stop/drain offscreen
   capture within its bound, retire pending state, then and only then settle the
   start caller. Constructor, config/branch/ticket failure, socket error/close,
   explicit close, and setup timeout must use the same exactly-once primitive;
   late callbacks cannot resettle or repeat teardown.
3. Serialize offscreen start/stop ownership with an exact generation or mutex.
   Concurrent deferred `getUserMedia()` acquisitions may leave only one active
   capture. Every superseded or failed acquisition must stop all tracks, close
   its AudioContext/worklet resources, and settle only after cleanup. Stop must
   truthfully identify the generation/session it retired.

## Required executable regressions

- successful local start ID plus malformed returned authority emits exactly one
  local close, awaits disposal, leaves no state/session, and emits no control;
- constructor/config/ticket/error/close/explicit-close/timeout paths hold the
  caller unresolved until mocked drain resolves; timeout-first/open-first and
  repeated late callbacks settle/teardown once;
- two and three deferred concurrent offscreen starts in adversarial resolution
  orders leave one owner during operation and zero live tracks/contexts after
  stop; superseded start responses cannot claim active ownership;
- preserve no-auto-SEND, exact eight-key SEND, authority/wrong-turn, capture
  ordering, ACK/no-ACK, capability/gesture, no-LiveKit, backpressure, and real
  headless smoke invariants.

## Ownership and constraints

Own only `browser_extension/**` and this browser lane's notes. Do not touch the
gateway, Android, active tree, or live browser. Do not commit, package, reload,
merge, or deploy.

## Verification

```sh
cd browser_extension
npm run verify
npm run smoke
git diff --check
```

Write `repair-audit-9-result.md` with actual shipped-function/full-offscreen
evidence and return PASS/BLOCK. Root will assign yet another fresh auditor.
