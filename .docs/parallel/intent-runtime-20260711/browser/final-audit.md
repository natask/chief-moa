# Browser draft controls fresh final audit

## Disposition

`BLOCK`.

The configured-endpoint generation, admitted gesture latches, pre-ID SEND
drain ordering, dependency order, strict received authority, and bounded audio
paths pass fresh source review and adversarial probes. Three release blockers
remain at local-authority and late-session boundaries.

## Blocker 1: numeric-zero local authority is treated as absence

`validateResumePointer` decides whether any authority was supplied at
`extension/voice-draft-protocol.js:176-179`. It excludes numeric `0` for every
field, not only the create-mode revision sentinel. Consequently numeric-zero
draft, session, or branch authority is accepted as a create with no pointer:

```json
{"draftId":0,"revision":0,"sessionId":"","branchId":""}
=> {"ok":true,"pointer":null}
{"draftId":"","revision":0,"sessionId":0,"branchId":""}
=> {"ok":true,"pointer":null}
{"draftId":"","revision":0,"sessionId":"","branchId":0}
=> {"ok":true,"pointer":null}
```

The background trusts this result before opening the session at
`extension/background.js:2333-2344`. Create mode legitimately uses an empty
string for ID/session/branch and integer zero only for revision; numeric zero in
an identifier position is malformed supplied authority and must fail closed.
The focused regression at `scripts/test-voice-draft-protocol.mjs:167-169`
checks a whitespace pointer and the canonical all-empty create tuple, but not
numeric zero in an identifier field.

## Blocker 2: a direct session ID bypasses exact turn binding

`findVoiceSessionForControl` returns a direct map hit at
`extension/background.js:3038-3041` before parsing or comparing the command's
turn ID. Executing the shipped function returned the same live session for
`commit_turn`, `cancel_turn`, and `discard_turn` carrying `turn-wrong`, just as
it did for `turn-good`.

The downstream checks are too late and incomplete:

- Draft directional controls happen to compare turns at `:3076-3082`.
- Draft `cancel_turn` performs terminal local effects at `:3115-3120` with no
  turn check. A focused execution with a wrong turn returned
  `{ok:true,cancelledLocally:true}`, marked the session committed, stopped
  capture once, and cleared queued media.
- Commit stops capture at `:3122-3125` before its wire builder rejects a wrong
  turn at `:2735-2745`. Before readiness, it can instead queue the malformed
  commit and report success.
- Ordinary non-draft control remains directly routable to the wrong turn.

Every direct-ID lifecycle command must bind the exact canonical session turn
before stopping capture, clearing media, queueing, or sending anything. The
tab-plus-turn fallback is strict; the supposedly stronger direct path cannot be
weaker.

## Blocker 3: cancel-before-start can leave an unattached session alive

Content correctly notices that cancellation won the delayed start at
`extension/content.js:2786-2799`, but it sends the close fallback only when the
discard request returns a non-success response. A pre-ready background session
accepts that discard at `extension/background.js:3076-3113`, stops capture,
queues it without authority, and returns success.

Executing those shipped lifecycle bodies produced:

```json
{
  "response":{"ok":true,"voiceSessionId":"late-session","queued":true,"awaitingAck":true},
  "contentWouldSendCloseFallback":false,
  "captureStopped":1,
  "sessionStillRegistered":true,
  "sessionClosed":false,
  "pendingAction":"discard_turn",
  "pendingSent":false
}
```

This queued pre-ready control has no timer: the ACK timer is armed only after
authority and send at `extension/background.js:2995-3003,3026-3035`. If ready
and ACK eventually arrive, `finalizeDraftControlAck` at `:3005-3009` only clears
the pending record; the inactive content state is no longer attached to process
the ACK and close the session. Thus a gateway that stays open can leave the
socket/session registered indefinitely. Late cancellation needs one atomic
background disposal path that stops/drains capture, performs discard/no-SEND
when authoritative, and always reaches bounded close/removal.

## Confirmed repairs

- The exact pre-ID SEND path waits for `captureStartPromise`, performs strict
  offscreen stop/drain, and only then queues commit
  (`extension/background.js:3038-3068,3122-3129`). A deferred-start probe
  observed no early result and the exact order `stop -> PCM drained -> commit`.
- Endpoint invalidation advances the generation and detaches the old promise
  (`extension/content.js:1270-1308`). In an A-pending/B-replacement probe, late
  A left capability disabled; only B's independently bound response enabled B.
- Admitted hold and tap-chain authority survives later feature/capability flips
  (`extension/content.js:664-684,1104-1216,3767-3779`). Executing the actual
  timer bodies after flips still started the admitted draft hold and resolved a
  double-tap with its latched draft admission.
- Manifest and programmatic injection load protocol, gesture, then content in
  dependency order (`extension/manifest.json:34`,
  `extension/background.js:2096-2102`).
- Draft mode bypasses LiveKit at `extension/background.js:2258-2286`.
- Offscreen capture stops hardware before an exact bounded drain, propagates
  rejected PCM, rejects mismatched stops, caps in-flight sends at 64, and times
  out drain work (`extension/offscreen.js:5-113,148-200`). Draft background PCM
  is byte-bounded and overflow fails visibly at
  `extension/background.js:2689-2713`.

## Verification

- `npm run test:voice-draft-protocol`: passed.
- `npm run test:voice-capture-gesture`: passed.
- `npm run test:offscreen-voice-capture`: passed.
- `npm run verify`: passed; seven lifecycle tests passed and extension
  verification completed.
- `npm run smoke`: passed against the real extension in headless Chrome for
  Testing without showing or focusing a window.
- Tracked and per-untracked-file whitespace checks: passed.

This audit changed only this note. It did not implement, commit, package,
reload, merge, preview, or deploy anything.
