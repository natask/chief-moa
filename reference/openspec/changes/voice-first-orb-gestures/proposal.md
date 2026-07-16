# Voice-First Orb Gestures

## Status

The current-thread gesture contract below supersedes the 2026-07-15 fresh-thread
double-click mapping. Android implements it behind the existing voice-first
setting; browser convergence remains a separate implementation lane.

## Why

The orb/mascot should be a dependable microphone control with the same muscle
memory on phone and browser. Multi-click resolution must never replace a durable
thread or leak a pending capture, and all automatic/manual send paths must be
idempotent.

## Accepted Contract

- Single click starts capture in the current thread; during capture it sends once.
- A still click-and-hold is push-to-talk in that same thread. Capture starts
  after the hold threshold and release stops and sends it once. Movement before
  the threshold remains a drag; a large movement after capture begins cancels
  capture and escapes into drag.
- Double-click starts/continues the current durable thread and never issues a
  fresh-thread action or replaces an active capture.
- Triple-click hard-interrupts active capture/playback/response without erasing
  prior transcript history.
- Fourth click and beyond do nothing.
- Drag repositions the mark and its open card. The Android removal target and
  explicit Hide actions retain their existing behavior.
- Tap drafts retain native X/Send alternatives. Orb tap, Send, and natural
  post-speech silence converge on the same idempotent commit; X cancels locally.

The mapping is identical across Android and the browser extension. Keyboard
shortcuts retain their existing meanings.

## Delivery Modes

Gestures control capture mechanics; the conversationally selected delivery
policy controls what happens after stop/release:

| Mode | Result |
| --- | --- |
| Ask | Store/send a conversational turn and allow the normal response path. |
| Note | Store through the raw audio-note path; no provider work, reply, or agent launch. |
| Coach | Store/send a conversational turn with the bounded turn-local coaching overlay. |

The gateway owns versioned, device-scoped Ask/Note/Coach admission as internal
routing state. Clients must not expose a mode selector. A user changes behavior
conversationally, and client preflight applies the admitted policy before
provider work. The gesture implementation does not claim that preflight yet.

## Flags

- Browser: `ageeVoiceFirstGesturesEnabled` in `chrome.storage.local`, exposed
  under Experimental in options.
- Android: `MoaPrefs` key `voice_first_gestures`; new installs default to the
  manual contract while an existing explicit preference remains respected.

## Separate Follow-Up: Clean Voice Into The Current Text Field

Speaking rough text, cleaning it, and inserting it into the focused field
without submitting is Dictate behavior, not Ask/Note/Coach and not another tap
chord. The destination surface owns focus revalidation and insertion; gateway
output remains an inert proposal. Android must use an IME/InputConnection path
for reliable system-wide insertion, and the browser must never infer submit.

## Boundaries And Non-Goals

- Android and the browser extension own gesture detection and local UI state.
- The gateway owns delivery-mode admission and provider routing.
- Chat remains reachable from the normal chat surface; triple-click is reserved
  for hard interruption.
- This unit does not add conversational mode switching,
  `capture_block`, notebook/IME, video routing, or automatic agent dispatch.
- Model output and screen context cannot change capture disposition.
- Concurrent capture while prior response audio continues requires a split
  Android controller and gateway causal queue and is not claimed by this unit.

## Verification

- Browser: `cd browser_extension && npm run verify && npm run smoke`.
- Android: `cd android_app && ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew testDebugUnitTest assembleDebug`.
- Physical Android QA remains required for timing, touch-slop, interruption,
  overlay movement, and a real voice round trip before OTA promotion.
- Browser manual QA remains required before active unpacked-extension reload.
