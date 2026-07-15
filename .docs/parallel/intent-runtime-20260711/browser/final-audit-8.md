# Browser draft controls final audit 8

## Disposition

`BLOCK`.

The candidate passes every focused suite, the static verifier, and the real
headless-Chrome smoke. The requested draft auto-commit, frozen SEND, normal
setup-timeout/open races, authority, capture-boundary, capability-generation,
gesture-latching, no-LiveKit, backpressure, and terminal-control regressions
also reproduce against shipped functions. A fresh trust/resource pass found
three cleanup failures that those gates do not exercise: invalid start
authority can orphan an admitted background session, non-timeout setup
failures settle before microphone drain, and concurrent offscreen starts can
leave a microphone track permanently live.

## Release blockers

### 1. Invalid start authority loses the only handle that can close the session

`extension/content.js:2783-2818` receives a successful background start and
validates its draft session/branch/turn authority before calling
`attachLiveVoiceSession`. If that authority is invalid, line 2812 throws while
`state.voiceSessionId` is still null. The catch at lines 2819-2820 reaches
`finishLiveVoiceError`, then `stopLiveVoiceState`, but
`closeLiveVoiceSession` returns immediately on a missing state-owned ID at
lines 3243-3252. The background session has already opened and cleared its
setup deadline, so no remaining local deadline retires it.

I extracted and executed those shipped content lifecycle functions with a
canonical returned `voiceSessionId` and a whitespace-padded returned session
authority. The actual validator rejected the authority, the content state was
retired, and no close was emitted:

```json
{
  "calls": ["voiceSessionStart"],
  "closes": [],
  "active": { "states": 0, "live": false }
}
```

Repair: once a start response contains a canonical local voice-session ID, any
subsequent authority-validation or attachment failure must dispose that exact
background session before retiring the content state. Invalid gateway-facing
authority must not be used for SEND/discard, but it must not prevent a local
`voiceSessionClose` by the already returned local session ID.

### 2. Socket/config/ticket setup failures do not share the timeout's drain gate

The timeout-first path is correctly drain-aware at
`extension/background.js:2344-2369`. The other pre-admission failure paths are
not. `failBeforeOpen` calls `abortVoiceSessionSetup` first at lines 2593-2595,
which rejects the promise raced back to the caller, and then launches
`stopOffscreenVoiceCapture` without awaiting it at lines 2596-2605. Constructor
and pre-socket setup failures similarly route through `closeVoiceSession` at
lines 2574-2580 and 2563-2567; that function aborts setup before a
fire-and-forget stop at lines 3249-3263.

I executed the shipped setup/deadline/start functions with a real extracted
pre-open socket-error callback and held the mocked offscreen drain unresolved.
The caller rejected while the drain was still held:

```json
{"phase":"held","settled":1,"stopStarted":1,"stopResolved":0,"sessions":0}
{"phase":"drained","settled":1,"result":"Live voice connection failed.","stopStarted":1,"stopResolved":1,"sessions":0}
```

This creates a real cross-session race: content can start another capture while
the prior capture is still draining, and a rejected/non-truthful stop is
discarded. Repair all pre-admission exits through one idempotent disposer that
unregisters first, performs the bounded truthful offscreen stop/drain, and only
then resolves or rejects the start caller. Constructor failure, config/ticket
failure, `error`, `close`, explicit close, and timeout must use the same
exactly-once primitive.

### 3. Concurrent offscreen starts can orphan microphone hardware

`extension/offscreen.js:116-161` has no start/stop transition mutex or
generation token. Each start first awaits `stopCapture`, then independently
awaits `getUserMedia` and installs itself as `activeCapture`. Two starts that
both pass the initial empty check can therefore acquire two streams. The later
one overwrites `activeCapture`; the earlier stream is no longer reachable by
`stopCapture`. The runtime listener at lines 218-233 admits both starts.

I executed the complete shipped `offscreen.js`, delayed both
`getUserMedia` calls, resolved both starts, and then truthfully stopped the
reported active session:

```json
{
  "starts": [{"ok":true},{"ok":true}],
  "stopB":{"ok":true},
  "tracks":[
    {"name":"a","stopped":false},
    {"name":"b","stopped":true}
  ],
  "worklets":2
}
```

The background counter at `extension/background.js:2290-2303` excludes record
mode but does not serialize same-tab voice starts, so this is reachable when a
new turn starts while a prior start/cancel is unresolved. Repair offscreen
capture transitions with one serialized owner/generation. Every acquired
stream must either become the sole active capture or have its tracks and audio
context closed before its start response settles. Add a deferred concurrent-
start regression that proves both the superseded and final tracks are stopped.

## Confirmed requested invariants

- Draft starts with omitted, false, and true `autoCommit` all set
  `autoCommitEnabled:false`; shipped scheduler and direct executor calls emit no
  implicit SEND (`extension/background.js:2441,3266-3293,3316-3346`).
- Every draft commit call site reaches `voiceSessionCommitWireMessage`; the
  builder emits exactly the frozen eight keys and strips `reason`, aliases, and
  unknown extras (`extension/background.js:2827-2878`). Extracted-function
  tests and real smoke cover both create and resume commits.
- The forever-CONNECTING timeout path unregisters before the held drain and
  settles once after drain; open-first clears the one deadline, and repeated
  timer/open/close/error callbacks do not resettle or send a second
  `session_start` (`scripts/test-voice-session-lifecycle.mjs:484-566`).
- Numeric-zero, numeric/boolean/whitespace/path/control/overlong authority,
  conflicting aliases, string/fractional revisions, wrong top-level/nested
  ready/ACK/terminal authority, same-revision resume, and malformed expected
  authority all fail closed in the shared shipped validator.
- Wrong-turn direct-ID commit/cancel/discard has zero capture, queue, pending,
  timer, or socket effects. Exact tab-plus-turn lookup remains the only pre-ID
  fallback (`extension/background.js:3137-3157`).
- Pre-ID SEND waits for capture-start settlement, then stops/drains before
  commit queueing. Cancel-before-start uses discard plus the bounded close
  path. Endpoint generation replacement, feature/capability flips during an
  admitted hold/chord, programmatic dependency order, and the draft no-LiveKit
  path remain green.
- Offscreen rejected PCM, 64-send backpressure, mismatched stop, stop-before-
  drain, and terminal discard ACK/no-ACK cases remain fail-closed. Blocker 3 is
  the uncovered transition race between two starts, not a failure of those
  single-capture cases.

## Service-worker suspension review

The setup/control deadlines are 10 seconds, below Chrome's normal 30-second
idle cutoff, and setup retains an unresolved runtime request while active
capture/runtime traffic or an admitted WebSocket supplies activity. I did not
reproduce a timer loss in the real-Chrome smoke. Still, all session authority
and timers live only in the in-memory `voiceSessions` map, and the manifest has
no minimum Chrome version. Chrome's own lifecycle guidance says globals are
lost on unexpected worker termination and that WebSocket lifetime support
begins in Chrome 116:
<https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle>.
That is a residual recovery/design risk, not a fourth independent blocker for
these sub-30-second deadlines. The shared disposer required by blocker 2 should
remain idempotent after worker/context loss, and the product should eventually
declare its real minimum supported Chrome version.

## Verification

- `npm run verify`: passed all four focused voice suites, seven sampler
  lifecycle tests, and `extension verification passed`.
- `npm run smoke`: passed against the real unpacked extension in headless
  Chrome for Testing, with no window shown and no focus taken.
- Tracked and per-untracked-file whitespace checks: passed.
- Source review covered every changed/untracked browser file and all production
  functions extracted by the new lifecycle tests.

This audit changed only this note. It did not edit implementation, commit,
package, reload, merge, preview, or deploy anything.
