# Browser draft controls final audit 10

## Disposition

`BLOCK`.

The three `final-audit-8.md` repairs reproduce against the shipped content,
background, and complete offscreen files. All earlier authority, release/SEND,
gesture, capability-generation, no-LiveKit, backpressure, ACK/no-ACK, focused
suite, verifier, and real-Chrome smoke gates are also green. A fresh
resource/lifecycle pass found two release blockers outside those regressions:
an offscreen pending start can report successful disposal while it still owns a
live provisional microphone stream, and a failed cleanup discards the only
background handle that could retry or reconcile that capture. The manifest also
does not define the Chrome compatibility floor on which its offscreen/WebSocket
lifecycle assumptions depend.

## Blocker 1: a pending start can report clean disposal while its microphone is live

`extension/offscreen.js:203-244` records only the request generation and then
awaits `getUserMedia()`. After the stream is live, it constructs an AudioContext
and awaits `audioWorklet.addModule()` at `:245-252`. The pending request still
does not own either provisional resource; the first resource-bearing `capture`
object is not constructed until `:262-275`.

Meanwhile, `stopCapture()` marks that request cancelled at `:166-173`, waits at
most two seconds for its completion at `:150-163,187`, and defines `stopped` as
true merely because a matching request existed at `:191`. The response carries
`cleanupPending:true` but the listener still returns `ok:true` at `:402-406`.
Background strict stop checks only `response.ok` at
`extension/background.js:2205-2226`; the shared disposer therefore reports a
clean stop even though it did not prove provisional cleanup.

I executed the complete shipped `offscreen.js` with a successful
`getUserMedia()` and a deliberately non-settling local worklet-module promise.
After the real two-second cleanup bound, the result was:

```json
{
  "case": "provisional_addModule_hang",
  "stop": {
    "ok": true,
    "stopped": true,
    "voiceSessionId": "voice-provisional",
    "generation": 1,
    "activeRetired": false,
    "pendingCancelled": 1,
    "alreadyRetired": false,
    "cleanupPending": true
  },
  "startSettled": false,
  "trackStopped": false,
  "contextClosed": false
}
```

Thus setup timeout, explicit close, malformed-authority disposal, or a draft
control can settle as if the microphone were retired while the offscreen
document still owns it indefinitely. The existing two/three-start tests defer
only `getUserMedia`; they do not stop after acquisition but before worklet
admission.

There is a second unbounded edge at `extension/offscreen.js:63-66,102-118`:
hardware stops first, but cleanup awaits `AudioContext.close()` without a bound.
A complete-file probe with a non-settling close promise left the stop response
unsettled after 2.25 seconds, although its track was stopped. By contrast, the
PCM drain timeout behaves correctly and visibly: a non-settling admitted audio
send returned `{ok:false,error:"Timed out draining microphone audio exactly."}`
after two seconds with both the track stopped and context closed.

Repair the pending-start record so it owns each provisional resource as soon as
that resource exists, check cancellation immediately after every acquisition
stage, and make the whole acquisition/cleanup response bounded. A strict
background stop must reject `cleanupPending:true`; it cannot treat that result
as exact disposal.

## Blocker 2: cleanup rejection erases retry and restart authority

The shared background disposer unregisters the live session before attempting
offscreen cleanup at `extension/background.js:2437-2459`. On both success and
failure it deletes the temporary `disposingVoiceSessions` entry at
`:2475-2483`. `closeVoiceSession()` can find a session only in those two
in-memory maps at `:3342-3348`. There is no persisted cleanup tombstone, no
offscreen active-capture status command, and no worker-start reconciliation.

I executed the shipped disposer and close functions with strict offscreen stop
rejecting as a runtime-channel failure. It unregistered first, rejected once,
and then made retry by ID impossible:

```json
{
  "error": "runtime channel disconnected",
  "retry": false,
  "voiceSessions": 0,
  "disposing": 0,
  "closed": true,
  "disposalRetained": true,
  "events": [
    "clear-control",
    "clear-auto",
    "clear-media",
    "socket-close",
    "stop-attempt",
    "abort-setup"
  ]
}
```

The rejected promise remains on an otherwise unreachable session object. If
the stop message failed before the offscreen document received it, neither the
content caller nor a restarted worker has authority to retry cleanup.

Manifest V3 makes this material rather than theoretical. Chrome documents that
service-worker globals are lost on termination, while an offscreen document
created for `USER_MEDIA` has no automatic lifetime limit. The current ordinary
active-capture path does have a useful safety net: after a simulated worker
restart with an empty `voiceSessions` map, the complete offscreen file stopped
the track on its first rejected PCM delivery:

```json
{
  "start": {
    "ok": true,
    "active": true,
    "voiceSessionId": "voice-before-restart",
    "generation": 1
  },
  "trackStoppedAfterFirstRejectedPcm": true,
  "messages": ["offscreenVoiceAudio", "offscreenVoiceError"]
}
```

That makes unexpected termination a bounded residual for an already-active,
still-producing capture. It does not protect the provisional no-PCM stage from
blocker 1, and it does not reconcile a stale background/content session or a
SEND whose terminal receipt was lost. Preserve a bounded retriable cleanup
tombstone until cleanup is proven, and add a worker-start handshake that asks
the offscreen document to retire any capture not backed by recovered authority.
Canonical draft pointers are already bounded and persisted in
`chrome.storage.local`; ephemeral socket/session state need not become the
product database.

## Chrome compatibility gate

`extension/manifest.json` has no `minimum_chrome_version`. Gateway capability
admission checks only `health.capabilities.voice_drafts_v1`; it does not include
the browser's offscreen/service-worker capability in the result. The real smoke
used Chrome for Testing `143.0.7499.192` and therefore says nothing about the
currently undeclared lower bound.

Chrome's official documentation says the Offscreen API is available from
Chrome 109, `runtime.getContexts()` begins at 116, service-worker globals must
not be treated as durable, offscreen-document messages begin resetting the idle
timer at 109, extension API calls at 110, and WebSocket activity at 116. The
official worker-WebSocket guide explicitly demonstrates
`minimum_chrome_version: "116"` plus activity inside the 30-second window:

- <https://developer.chrome.com/docs/extensions/reference/api/offscreen>
- <https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle>
- <https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets>

Before release, either declare and test the actual supported floor (116 is the
documented WebSocket baseline), or explicitly client-gate draft controls and
prove recovery on every older supported version. Raising the floor affects
existing users' update eligibility, so this must be a deliberate release
decision, not an implicit assumption.

## Confirmed final-audit-8 and earlier invariants

- Malformed returned gateway authority preserves the canonical local session
  ID, emits exactly one awaited local close, leaves the content state owned
  until that close settles, and emits no SEND/discard control.
- Config, branch, ticket, missing-ticket-URL, socket-constructor, pre-open
  error, pre-open close, explicit close, and setup timeout all share the
  unregister -> socket close -> mocked truthful drain -> settle-once ordering
  when the capture primitive itself settles. Late socket callbacks do not
  repeat teardown or resettle callers.
- Cancellation before offscreen-document creation reserves synchronously,
  emits no start/stop message, and prevents a late start.
- Complete-file two- and three-start races in adversarial resolution orders
  leave exactly one newest owner during operation and zero tracks, contexts,
  and worklet ports after final stop.
- Draft starts with omitted, false, or true `autoCommit` emit no implicit SEND.
  Every draft SEND has exactly the frozen eight keys and strips legacy reason,
  aliases, and unknown fields.
- Numeric, boolean, whitespace, path/control, overlong, conflicting-alias,
  numeric-zero, string/fractional revision, wrong-turn direct-ID, malformed
  ready/ACK/terminal, and stale-revision cases fail closed.
- Pre-ID SEND drains before queueing; setup and control deadlines, ACK/no-ACK,
  capability generation, admitted hold/chord latching, programmatic dependency
  order, draft no-LiveKit selection, exact PCM backpressure, rejected delivery,
  and mismatched stop remain green.

## Verification

`cd browser_extension && npm run verify` passed:

```text
voice-draft-protocol ok
voice-capture-gesture ok
voice-session-lifecycle ok
offscreen-voice-capture ok
tests 7; pass 7; fail 0
extension verification passed
```

`cd browser_extension && npm run smoke` passed against the real unpacked
extension in headless Chrome for Testing:

```text
extension smoke passed (REAL extension, headless Chrome for Testing): service worker loaded id=pcijjnjihfnnokelkaeecdifbhmhppon, text shortcut=⌘,, voice shortcut=page-level listener, 5 elements observed via background->content, 149 visible text chars observed, compact overlay checked (540x58), cross-tab owner moved 1999894815->1999894816 with old tab revoked, type+click executed, demo result "Searched Docs: browser agent", no window shown, no focus taken.
```

Tracked `git diff --check` and per-untracked-file whitespace checks passed. I
inspected every changed and untracked browser source, focused test, verifier,
smoke addition, manifest/options/package edit, and all browser lane contracts,
audits, evidence, and results through `repair-audit-9-result.md`.

This audit changed only this note. It did not edit implementation, commit,
package, reload, merge, preview, or deploy anything.
