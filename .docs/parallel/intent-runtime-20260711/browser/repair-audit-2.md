# Browser Draft Controls Repair Contract 2

## Audit disposition

`BLOCK`. The focused resolver, verification harness, and real headless Chrome
smoke all pass, but they currently bless a non-canonical readiness envelope and
do not exercise the trust failures below. Draft PCM can also be reported as
drained after a rejected runtime send or a mismatched capture stop.

## Gate evidence

- `npm run test:voice-capture-gesture`: passed (`voice-capture-gesture ok`).
- `npm run verify`: passed (`extension verification passed`, 7/7 lifecycle tests).
- `npm run smoke`: passed against the real extension in headless Chrome.
- `git diff --check -- browser_extension .docs/parallel/intent-runtime-20260711/browser`: passed.
- Manifest JSON and package JSON parse; manifest moved from `0.1.29` to
  `0.1.30`.

Passing these gates is not sufficient evidence because
`scripts/smoke-extension.mjs:1063-1073` sends `voice_draft_ready` without the
required top-level session, branch, or turn authority, while
`scripts/smoke-extension.mjs:1152` explicitly expects the incorrect
`context_action:"create"` wire value.

## Release blockers

### 1. `voice_draft_ready` is not an authoritative admission gate

- `extension/background.js:2886-2910` checks event type and action but never
  checks top-level `session_id`, `branch_id`, or `turn_id`.
- The same block accepts any non-empty nested state; create and resume readiness
  must require `draft.state === "capturing"`.
- `extension/background.js:2897-2898` accepts the same revision for resume.
  Resume is a transition and must require an integer revision strictly newer
  than the requested parked revision.
- `extension/content.js:2773-2788` independently treats a shallow type/action
  match as ready and persists whatever nested pointer it sees. Background is the
  primary trust gate, but content must not contain a weaker competing authority
  interpretation.

Repair: accept only `type:"voice_draft_ready"`, exact `action:"create"` or
`"resume"`, exact top-level session/branch/turn, a nested authority whose
session/branch equal both top-level and requested authority, exact state
`capturing`, and a positive integer revision (strictly newer for resume). Until
that succeeds, do not set `gatewayReady`, flush PCM/control/SEND, persist a new
pointer, or restart resumed capture. Invalid readiness closes visibly and never
falls back to LiveKit or an ordinary provider session.

### 2. Revision and context wire values are not canonical

- `extension/background.js:2339-2346` coerces resume revisions to strings and
  defaults `context_action` to `create`/`resume`.
- `extension/background.js:2503-2512` sends those values on `session_start`.
- `extension/background.js:2869-2871` and `extension/content.js:260-262`
  coerce numeric strings into accepted revisions rather than requiring an
  integer JSON value.
- `extension/content.js:227-235` normalizes every persisted revision to a
  string, guaranteeing a string-valued resume envelope.

Repair: store and send revisions as safe positive integers only. The
`session_start` context action is `continue`, `new`, `fork`, or `incognito`;
create/resume belongs only in `voice_draft_ready.action`. Default create and
resume both use `context_action:"continue"`, while double tap uses exactly
`"new"`.

### 3. ACK and terminal receipts do not bind the complete authority

- `extension/background.js:2927-2936` validates nested draft authority and turn
  but not the ACK's top-level session and branch.
- `extension/content.js:961-981` repeats the incomplete ACK gate.
- `extension/content.js:993-1004` accepts terminal receipts with no turn ID and
  does not require a revision newer than the currently bound draft before
  clearing pointers.

Repair: canonical control ACK requires exact type, pending action, top-level
session/branch/turn, matching nested ID/session/branch, expected state, and a
strictly newer integer revision. Terminal pointer clearing requires an exact
`turn_done` turn ID, matching nested authority, state `sent` or
`discarded`, and a strictly newer integer revision. Clear by matching draft ID
only after that real terminal receipt.

### 4. Capability freshness is enforced only when somebody asks again

- The background cache correctly binds URL and TTL at
  `extension/background.js:166-200`.
- Content refreshes only on startup/config/flag changes
  (`extension/content.js:1230-1241`, `3644-3663`) and retains a prior `true`
  indefinitely. `extension/content.js:642-656` can therefore latch draft mode
  long after the 30-second cache expired.
- A refresh request does not first invalidate a prior supported value, so a
  pending or hung health request can reuse stale support.

Repair: return an explicit expiry with the capability record and enforce it in
content at pointer-down/chord admission. Expired, URL-mismatched, failed, or
pending capability is immediately non-draft and triggers an asynchronous
refresh; it may use visibly legacy voice behavior but must not claim draft
pause/park. A late response cannot change the gesture already in progress.

### 5. Gesture mode is only partially latched

- Pointer-down stores draft capability at `extension/content.js:647-657`, and
  directional action latching at `689-697` is otherwise sound.
- Movement and release still consult the mutable global flag at
  `extension/content.js:688`, `752`, and `757`. Turning the flag off mid-hold can
  turn the same draft gesture into SEND or local cancel instead of the latched
  direction/discard.
- Deferred tap resolution stores no feature/capability admission in the chord
  (`extension/content.js:1132-1165`), so a health/flag change inside the chord
  window changes whether double tap creates a draft or provider-backed turn.

Repair: latch feature mode, fresh capability decision, draft/legacy mode, and
the first valid dominant direction at pointer-down/chord admission. Use only
those values through release. A latched draft `pointercancel` remains discard
even if storage changes mid-hold; an unsupported ordinary hold uses existing
cancel semantics and never commits on cancellation.

### 6. Offscreen drain can silently lose PCM or falsely report a stop

- `extension/offscreen.js:109-120` catches each rejected runtime audio send and
  turns it into a fulfilled promise. `stopCapture` therefore cannot know that a
  pre-control PCM chunk was lost.
- `extension/offscreen.js:156-159` discards the boolean result of `stopCapture`;
  a missing or session-mismatched capture is returned to background as
  `{ok:true}`. Background's strict stop can then emit a control without proving
  the intended capture stopped.
- The `pendingAudioSends` set and `Promise.allSettled` wait at
  `extension/offscreen.js:64,100-120` have no outstanding-count or settlement
  bound. A non-settling runtime send can grow memory and hold teardown forever.

Repair: preserve per-send success/failure through drain, return the real stop
result, and fail closed before control/SEND on any rejected PCM delivery or
session mismatch. Bound outstanding sends; capacity or drain timeout stops the
microphone and surfaces a non-recoverable error rather than dropping audio or
emitting the control. Do not weaken exact PCM ordering.

## Required adversarial verification

Add behavioral tests (source-presence checks may remain secondary) that prove:

1. Missing/mismatched top-level ready session, branch, or turn; wrong nested
   state; string/fractional revision; and same-revision resume all leave PCM and
   controls unflushed, never start resumed capture, and close visibly.
2. One valid create and one valid resume ready event bind authority; resume
   emits an integer revision and strictly advances it.
3. Default create/resume emit `context_action:"continue"`; double tap emits one
   `context_action:"new"`; triple tap emits zero voice starts/cancels.
4. ACKs with wrong/missing top-level authority, wrong action/state, stale/string
   revision, or wrong turn remain pending. Only the canonical ACK advances.
5. Terminal receipts with missing/wrong turn or stale/string revision do not
   clear a pointer; a newer matching sent/discarded receipt does.
6. Advance a fake clock past capability expiry and hold before refresh returns:
   the gesture cannot enter draft mode or claim pause/park. Endpoint changes and
   health failures behave the same. A late success affects only the next
   gesture.
7. Flip feature/capability during a hold and during a tap chord. The latched
   direction/mode remains unchanged, and `pointercancel` never SENDs.
8. Reject one offscreen PCM `sendMessage`, return a session-mismatched stop, and
   exceed the exact draft queue cap. Each case is visible, sends no draft
   control/commit, and drops no prefix silently.
9. With experimental LiveKit enabled, every draft start still uses only the
   standard draft proxy.

## Verification after repair

```sh
cd browser_extension
npm run test:voice-capture-gesture
npm run verify
npm run smoke
git diff --check -- .
```

Do not commit, package, reload, merge, or deploy during repair. The main
orchestrator reruns the gates and a fresh independent audit.
