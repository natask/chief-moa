# Browser draft controls final audit 6

## Disposition

`BLOCK`.

The three `final-audit.md` repair targets now pass against exported validators
and extracted shipped lifecycle functions. The prior release/drain,
late-response, endpoint-generation, gesture-latching, dependency-order,
no-LiveKit, and bounded-offscreen cases also pass. The broader trust/resource
ring found three remaining draft-boundary failures: draft auto-commit is not
structurally disabled, that implicit path can add a ninth field to the frozen
SEND envelope, and a socket that never opens has no setup deadline while fresh
draft capture is already running.

## Confirmed final-audit repairs

### Numeric zero is malformed authority, while revision zero remains create

`extension/voice-draft-protocol.js:176-189` distinguishes role-specific
absence. Executing `validateResumePointer` rejected numeric zero independently
for draft, session, and branch; `validateStartAuthority` rejected a numeric-zero
turn. The all-empty identifier tuple with integer revision zero still returned
`{ok:true,pointer:null}`. The checked-in regressions cover the same boundary at
`scripts/test-voice-draft-protocol.mjs:170-191`.

### Wrong-turn direct IDs have zero lifecycle effects

`extension/background.js:3040-3060` validates an exact canonical turn before
returning a direct session. Executing the shipped
`findVoiceSessionForControl`/`sendVoiceSessionControl` bodies rejected direct-ID
`commit_turn`, `cancel_turn`, and `discard_turn` for `turn-wrong` while leaving
committed state, capture state, queued PCM identity/bytes, pending control,
socket writes, capture stops, media clearing, commit queueing, and timers
unchanged. The repository regression binds the same shipped bodies at
`scripts/test-voice-session-lifecycle.mjs:101-155`.

### Pre-ready discard is bounded and a valid ACK wins

`extension/background.js:2995-3010,3111-3125` arms a 10-second deadline even
before draft authority is ready, clears it on an admitted ACK, and closes a
terminal discard session. Executing those bodies produced both orderings:

- no ACK: the 10,000 ms callback closed the socket/session and removed its map
  registration;
- valid exact discard ACK first: the validator admitted revision 2, finalization
  cleared the timer and removed the session, and manually invoking the stale
  callback afterward had no effect.

The checked-in no-ACK case is at
`scripts/test-voice-session-lifecycle.mjs:157-208`; the fresh audit additionally
ran the ACK through the real `voiceDraftControlAcknowledged` validator rather
than handing a synthetic authority directly to the finalizer.

## Remaining release blockers

### 1. Draft mode can still silence-auto-commit without explicit SEND

`extension/background.js:2366` derives `autoCommitEnabled` solely from the
caller's `autoCommit` value and the global legacy flag; it does not force this
off for `draftMode`. The draft's normal content path currently supplies false,
but the background is the local authority boundary and accepts a draft start
whose caller omits that optional value. Once enabled,
`extension/background.js:3168-3195,3218-3242` schedules silence/max-duration
commit and calls `sendVoiceSessionControl({type:"commit_turn"})`.

Executing the shipped audio/activity/timer functions with the exact state a
draft start gets when `autoCommit` is omitted produced:

```json
{
  "draft_auto_commit_enabled": true,
  "scheduled_ms": 900,
  "speech_ms": 250,
  "implicit_send": {
    "type": "commit_turn",
    "turn_id": "turn-auto",
    "reason": "browser_auto_commit:silence after speech"
  }
}
```

That violates the core invariant that capture/pause/park may not execute and
only an explicit user SEND may enter provider orchestration. Make draft mode
force auto-commit off in background regardless of caller input, and add a
negative regression that omitting or setting `autoCommit:true` cannot schedule
or emit SEND.

### 2. Draft SEND is not an exact frozen eight-key envelope

The ordinary draft path currently emits the expected eight fields, but
`extension/background.js:2729-2756` copies an optional caller `reason` into the
gateway wire. Executing the actual builder with the auto-commit message above
returned these keys:

```json
[
  "type",
  "voice_draft_mode",
  "voice_draft_id",
  "expected_revision",
  "idempotency_key",
  "session_id",
  "branch_id",
  "turn_id",
  "reason"
]
```

The frozen cross-surface SEND shape is exactly the first eight keys. Strip
legacy reason/extra input from draft SEND and assert the exact key set plus
forbidden extras, as the Android protocol lane already does. Presence-only
checks in `scripts/verify-extension.mjs:419-457,534-545` and the smoke assertions
do not catch this ninth field.

### 3. A never-opening draft socket can strand live capture indefinitely

Fresh draft capture starts before ticket/socket admission at
`extension/background.js:2391-2411`. The setup promise then waits for WebSocket
`open|error|close` at `extension/background.js:2486-2584`; there is no setup
deadline. The new control deadline does not exist until a control is queued.
For a generic cancel that occurs while content still has no returned session ID,
the late-start disposal at `extension/content.js:2786-2799` cannot run until the
never-settling start response returns.

Executing the shipped `startVoiceSessionProxyLocked` body with a WebSocket that
stayed `CONNECTING` produced:

```json
{
  "start_response_settled": false,
  "session_registered": true,
  "capture_started": true,
  "setup_deadline_count": 0,
  "events": ["capture-started", "socket-connecting"]
}
```

Add a bounded setup/admission deadline that closes/removes the session, stops
and drains capture, settles the runtime response, and cannot race a valid open.
Cover both timeout-first and open-first orderings.

## Prior race and trust evidence

- Pre-ID SEND executed in the exact order capture-start settlement -> strict
  offscreen stop/drain -> commit queue; no stop or commit occurred before the
  capture-start promise settled (`extension/background.js:3063-3076,3134-3141`).
- Malformed expected authority, delayed-start disposition, and old capability
  generation were reproduced through the exported protocol helpers.
- A feature/capability flip did not mutate the frozen admission object, and the
  actual storage-change body contains no tap-chain or hold-timer reset.
- Draft mode selected the standard proxy while mocked LiveKit support was on;
  the LiveKit starter was called zero times
  (`extension/background.js:2261-2286`).
- Manifest and programmatic injection both load protocol -> gesture -> content
  (`extension/manifest.json:31-38`, `extension/background.js:2096-2102`).
- Offscreen tests proved stop-before-drain, rejected delivery propagation,
  64-send backpressure, mismatched-stop rejection, and hardware teardown
  (`extension/offscreen.js:5-113,148-200`).
- The real headless smoke exercised the extension service worker/content path
  without showing or focusing a window.

## Verification

- `npm run test:voice-draft-protocol`: passed.
- `npm run test:voice-session-lifecycle`: passed.
- `npm run test:voice-capture-gesture`: passed.
- `npm run test:offscreen-voice-capture`: passed.
- `npm run verify`: passed; all focused suites, seven sampler lifecycle tests,
  and static verification passed.
- `npm run smoke`: passed against the real extension in headless Chrome for
  Testing; no window was shown and no focus was taken.
- Tracked and per-untracked-file whitespace checks: passed before this note and
  must be rerun by the orchestrator after handoff.

This audit changed only this note. It did not edit implementation, commit,
package, reload, merge, preview, or deploy anything.
