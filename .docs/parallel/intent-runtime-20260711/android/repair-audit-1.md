# Android Draft Controls Repair Contract 1

## Audit disposition

`BLOCK`. The resolver is correct and the Android build passes, but the surface
state can still execute or lose authority around capability, admission,
readiness, cancellation, resume, and acknowledgements.

## Required repairs

1. Cache `/health` capability `voice_drafts_v1` with an explicit freshness
   bound. Start draft mode only when advertised. An absent/stale capability
   keeps legacy voice available and disables pause/park claims.
2. Resolve new/fork/incognito before opening the draft socket. Bind the draft
   start to the resolved session/branch/context action. Failure is visible and
   closed; never open on `default` and refile only at SEND.
3. Draft-mode setup failure must never retry through an ordinary provider-backed
   voice path. It may remain/return to an honest idle or parked state only.
4. `ACTION_CANCEL` is a terminal pre-SEND discard request even before
   `session_ready`. Queue it until the draft ID/revision is bound, keep capture
   stopped, and never restart the microphone while discard is pending.
5. Pause/park/discard controls carry draft ID, expected revision, and a stable
   idempotency key. Resume sends the parked ID/revision/authority in draft-mode
   `session_start` (or an explicit resume control) and waits for an authoritative
   acknowledgment before capture restarts.
6. Accept a draft acknowledgment only for a known event type, the pending
   action, matching draft ID/session/branch, and a strictly newer integer
   revision. Arbitrary matching state strings are not acknowledgments.
7. Generic cancel/teardown of a local pre-SEND draft must request discard or
   rely on gateway auto-park; it must never send canonical `cancel_turn`.
8. Persist the latest paused/parked pointer (ID, revision, session, branch) in
   Android-owned preferences so process/app restart can resume or discard it.
   Clear it only after a real consumed/discarded acknowledgment.
9. Preserve the verified resolver: one axis at least 1.25x dominant after
   `max(48dp, 2*touchSlop)`; left pause, up park, down discard, right/diagonal
   unlatched, and `ACTION_CANCEL` discard. Flag-off and pre-hold drag remain
   compatible.
10. Add deterministic unit tests for capability parsing/freshness, readiness
    races, fail-closed admission/fallback, revision/ack matching, persisted
    pointer restore, resume envelope, and draft-vs-canonical cancellation.

## Owned files

Android app source/tests and this slice note only. Do not touch gateway,
browser, deployment, credentials, or active app data.

## Verification

```sh
cd android_app
ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew testDebugUnitTest assembleDebug
```

The main orchestrator reruns the gate and a fresh independent audit before
commit/merge.

## Implementation map for the repair implementer

- Keep capability parsing/freshness pure and unit-testable (a small helper is
  preferable to embedding wall-clock rules in `OverlayService`). Bind a cached
  result to the normalized gateway URL, require an explicit
  `capabilities.voice_drafts_v1:true` (or the final documented health shape),
  and reject negative age, clock rollback, or age beyond 30 seconds.
- Add a bounded `MoaGatewayClient.health()` read and refresh the cache away from
  the UI thread. Pointer-down latches one fresh capability decision; a later
  response cannot change the gesture already in progress.
- Represent the parked pointer as one exact JSON value containing draft ID,
  integer revision, session ID, and branch ID. Add `MoaPrefs` get/set/clear
  helpers and pure round-trip/invalid-shape tests. Never persist transcript or
  PCM in preferences.
- Extend `MoaVoiceGatewaySocket` with pure builders for draft start/resume and
  controls. Every control must contain type/action, draft ID, expected revision,
  stable idempotency key, session, branch, and turn. Unit-test exact JSON.
- In `MoaStreamingVoiceSessionController`, make a pending control durable in
  memory before readiness and stop capture immediately. Flush it only after an
  authoritative draft-ready event. Accept only documented draft event types,
  the pending action, exact draft/session/branch, and `revision > priorRevision`.
  Do not infer success from a free-form `state` string.
- Resolve new/incognito before `startStreamingVoiceDraft`, exactly like the
  existing legacy `resolveThreadBranchThenOpenStreamingVoice` flow. Construct
  the draft controller only with the resolved branch/context action. A failed
  switch returns a visible error without a socket or microphone restart.
- Split generic teardown by mode: local draft requests discard (or closes for
  gateway auto-park when discard cannot be acknowledged); legacy canonical
  turns may retain `cancel_turn`. Socket/setup failure in draft mode never calls
  `startLocalVoiceTurn`, `startStreamingVoiceTurn`, or another provider path.
