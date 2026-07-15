# Voice-First Orb Gestures

## Status

The manual gesture contract below was authorized on 2026-07-15 and is
implemented for Android and the browser extension behind their existing
voice-first settings. The earlier review-before-send `X — orb/mascot — Send`
contract is superseded and its side controls have been removed.

## Why

The orb/mascot should be a dependable microphone control with the same muscle
memory on phone and browser. Capture starts and ends only through an explicit
user gesture. Silence detection must not decide when a normal manual turn ends,
and a hidden multi-click collision must never send or leak a pending capture.

## Accepted Contract

- Single click toggles a manual capture in the current thread. The first click
  starts capture (and may interrupt current assistant speech); the next single
  click stops and sends it once.
- A still click-and-hold is push-to-talk in that same thread. Capture starts
  after the hold threshold and release stops and sends it once. Movement before
  the threshold remains a drag; a large movement after capture begins cancels
  capture and escapes into drag.
- Double-click toggles a manual capture in a fresh thread. The first double-click
  starts with `context_action:"new"`; the next double-click stops and sends that
  fresh-thread capture. If current-thread capture was active, the first
  double-click cancels it without sending before starting fresh.
- Triple-click cancels any pending capture without sending and opens chat.
- Fourth click and beyond do nothing.
- Drag repositions the mark and its open card. The Android removal target and
  explicit Hide actions retain their existing behavior.
- No separate X/Send draft controls own disposition. The gesture that started
  capture, hold release, or triple-click is the authority.

The mapping is identical across Android and the browser extension. Keyboard
shortcuts retain their existing meanings.

## Delivery Modes

Gestures control capture mechanics; the selected delivery mode controls what
happens after stop/release:

| Mode | Result |
| --- | --- |
| Ask | Store/send a conversational turn and allow the normal response path. |
| Note | Store through the raw audio-note path; no provider work, reply, or agent launch. |
| Coach | Store/send a conversational turn with the bounded turn-local coaching overlay. |

The gateway now owns versioned, device-scoped Ask/Note/Coach admission. Client
selectors and client preflight integration are separate follow-up tickets, so
the gesture implementation does not claim end-to-end mode selection yet.

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
- Chat remains reachable by triple-click.
- This unit does not add client mode selectors, spoken mode switching,
  `capture_block`, notebook/IME, video routing, or automatic agent dispatch.
- Model output, screen context, and silence cannot change capture disposition.

## Verification

- Browser: `cd browser_extension && npm run verify && npm run smoke`.
- Android: `cd android_app && ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew testDebugUnitTest assembleDebug`.
- Physical Android QA remains required for timing, touch-slop, interruption,
  overlay movement, and a real voice round trip before OTA promotion.
- Browser manual QA remains required before active unpacked-extension reload.
