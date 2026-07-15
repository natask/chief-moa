# Browser Draft Controls Repair Contract 1

## Audit disposition

`BLOCK`. The resolver is green and the real extension smoke reached every
direction, but the surface still has authority, ordering, cancellation,
capability, exact-audio, and chord-admission failures.

## Required repairs

1. Draft-mode starts always use the standard draft-aware proxy. They must never
   enter experimental LiveKit or any provider path before SEND.
2. Latch both the feature/capability mode at pointer-down and the first valid
   dominant direction after the threshold. Later capability refresh or movement
   back toward center cannot turn pause/park/discard into SEND.
3. `pointercancel` never commits. A draft hold requests discard; an unsupported
   or ordinary hold cancels locally/with existing `cancel_turn` semantics.
4. A control released before `voiceSessionId`/`session_ready` must remain queued
   against the unique turn/setup, stop offscreen capture immediately, flush all
   preceding exact PCM, and send only after draft authority is bound. Missing
   ACK cannot leave capture running.
5. Accept ACK only for an explicit draft ACK/state event, the pending action,
   matching draft ID/session/branch, and a strictly newer integer revision.
   Clear pending state on every socket/error/teardown path.
6. Capability cache is bound to normalized gateway URL and has a short hard
   expiry. Health failure, endpoint change, absent capability, or expired cache
   disables draft controls; never inherit support from another gateway.
7. Draft PCM queues fail visibly on capacity instead of dropping any prefix.
   Ordinary legacy behavior may retain its existing bounded drop policy.
8. Terminal consumed/discarded updates clear pointers by draft ID even though
   revision advances. Session-ready resume moves the same draft out of parked;
   retain a pointer until authoritative terminal completion, not optimistic
   SEND.
9. Chord admission is deferred: a first tap waits for the bounded chord window.
   Double-tap starts only one `context_action:new` draft and never an ordinary
   current-thread provider turn first. Triple-tap opens text with zero voice
   session starts. Update smoke to reject transient starts/cancels.
10. Resume pointers carry ID/revision/session/branch. Missing/mismatched authority
    fails closed; cue IDs never replace a stored draft branch.
11. Update verification to assert behavior without brittle stale source-order
    regexes. Keep the real headless extension smoke green and bump the manifest
    patch version for the release artifact.

## Owned files

Browser extension source/tests/scripts, manifest/package metadata, and this
slice note only. Do not touch gateway, Android, deployment, credentials, or
active browser state.

## Verification

```sh
cd browser_extension
npm run test:voice-capture-gesture
npm run verify
npm run smoke
```

The main orchestrator reruns all gates and a fresh independent audit before
commit/merge/package/reload.
