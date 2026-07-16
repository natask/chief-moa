# Voice-First Orb Gestures (Experimental)

## Why

The product goal is a voice-driven interface: speaking alone gets things done.
Today the cheapest orb gesture (single click) opens the typed chat surface, and
push-to-talk costs a double-click plus a hold on both surfaces. The user
proposed inverting that: promote voice gestures one tier up, demote chat to
triple click, and remove chat from the primary position over time. Assessment
and gesture contract: `scratch/agent-loop/voice-first-orb-gestures-20260706.md`.

## What Changes

Behind an experimental flag, off by default, the Android surface uses the
review-before-send v4 contract:

- Single click/tap while idle: start a reviewable draft in the current voice
  thread. Android immediately shows native Cancel and Send controls on either
  side of the orb; the browser shows the equivalent controls beside its mascot.
  A later orb or mascot tap never commits the draft; disposition stays visible
  and reversible beside the mark, independent of the content surface.
- Double-click, quick: start a distinct parallel voice session using a new
  local voice-session identity and the existing one-shot
  `context_action:"new"` path. The fresh branch keeps standing facts without
  inheriting the current thread's replies, while the prior session's visible
  message remains rendered and retains its identity.
- Single click while that double-click-started session is active: stop capture
  and commit its buffered utterance exactly once. This state-specific stop is
  not an idle draft gesture or the first click of another chord.
- Triple-click, quick: opens the chat/text surface (demoted, still reachable).
  If the double-click started a fresh loop milliseconds earlier, that loop is
  cancelled first so chat never leaves a hot mic.
- Single press-and-hold, still: push-to-talk. Mic warms at press-down where
  the surface supports it; release commits the turn. Movement past the drag
  slop before the hold threshold stays a drag, and a large movement after the
  hold confirms cancels the capture and escapes into a drag (hold-then-move
  muscle memory).
- Fourth click and beyond: nothing.
- Drag repositions the orb and its bounded content surface together. Transcript,
  reply, generated-image, composer, and status content stays wholly above the
  reserved orb/grab-line band with a visible gap, including while content is
  added or resized.
- Dragging the orb into the bottom removal target and releasing hides the orb
  and stops the overlay service, capture, and playback. Android atomically
  removes every overlay-owned window: orb, grab line, content surface,
  composer, draft controls, status, and removal target. The chat header and
  foreground notification expose a second explicit Hide action with the same
  teardown behavior.

The v1 trial mapping (single tap = interrupt, double = talk toggle, triple =
chat), v2 mapping (single tap = talk toggle, double = chat), and v3
single-tap start/send toggle are superseded on both Android and the browser
voice-first path.

## Accepted Review-Before-Send Revision (2026-07-14)

The next product revision makes the cheapest gesture consistent and visibly
reversible on Android and in the browser:

- A single click starts a voice draft and immediately exposes two controls:
  `X` to cancel/discard and one affirmative `Send` control to commit. The
  affirmative control may use a send arrow or a check/yes treatment, but it is
  one semantic action rather than separate Yes and Send actions.
- A single click never silently commits an ordinary tap-started draft. The user
  can keep speaking, cancel, or explicitly send from the visible controls. A
  single click during a double-click-started session is the explicit
  stop-and-commit gesture defined above.
- A still press-and-hold remains push-to-talk; release commits immediately.
  This preserves the fast eyes-free path on both surfaces while the click path
  favors review and correction.
- Android and browser use the same visible draft states and meanings: Cancel
  always discards and Send always commits. Android uses native controls and
  standard close/send iconography; the browser uses its equivalent dark
  controls. The transcript or chat surface never owns those actions.
- Double, triple, and fourth clicks must not accidentally send an ordinary
  tap-started draft. Double-click starts the distinct parallel session described
  above; triple-click cancels any milliseconds-old capture before opening chat;
  fourth and later clicks do nothing.

The user aligned this revision for Android implementation and deployment on
2026-07-14, then clarified that the same geometry and behavior must ship in the
desktop browser extension.

### Native Android Overlay Presentation

Android SHALL use platform-native interactive controls for Cancel, Send, the
grab affordance, and the bottom removal target. These controls use the overlay's
black/dark treatment with native pressed feedback, enabled state, accessibility
role, and content description. The removal target follows the familiar native
floating-window drag-to-close interaction without changing the branded orb
itself.

### Separate Follow-Up: Clean Voice Into The Current Text Field

The user also wants a composing feature: speak rough text, have Moa clean it
up, and place the result into the text field currently in use without sending
it. This is distinct from sending a turn to Moa:

- The destination surface owns detection of the currently focused editable
  field and the local insertion action.
- The gateway may return a cleaned-text proposal, but it cannot type into the
  field directly. Android accessibility or the browser extension revalidates
  focus, previews when appropriate, performs the insertion, and receipts it.
- Insertion never implies submit, send, click, or form completion.
- The invocation gesture remains unresolved. A directional swipe from the
  active voice draft is preferred for exploration because double/triple/fourth
  click meanings are already crowded and poorly discoverable.

Flags:

- Browser: `ageeVoiceFirstGesturesEnabled` in `chrome.storage.local`, checkbox
  under Experimental in options.
- Android: `MoaPrefs` boolean `voice_first_gestures`, toggle in the settings
  app.

## Non-Goals

- No chat removal yet; triple click keeps it reachable.
- No change to the Cmd+./Cmd+, hotkeys (they already match the proposed shape).
- No gateway, voice-session protocol, or provider changes.
- No default-on flip; that decision follows the experiment.

## Boundaries

- Android and the browser extension own gesture detection and local UI state.
- The gateway voice contract is reused untouched.
- With the flag off, both surfaces keep the legacy contract byte-for-byte.

## Verification

- Browser extension: `cd browser_extension && npm run verify && npm run smoke`.
- Android: `cd android_app && ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew assembleDebug`.
- Android manual QA with the flag on: single click starts a draft with visible
  native Cancel and Send controls; only Send commits; Cancel discards; a later
  orb tap does not send;
  double-click starts a distinct parallel voice session without clearing the
  prior visible message; one following single click ends and commits that
  session exactly once; triple-click opens chat; hold-to-talk release commits;
  all content remains wholly above the moved orb/grab line; and dragging onto
  the native dark removal target clears every overlay window. Flag off restores
  the legacy gestures.
- Browser manual QA with the flag on: one mascot click starts a draft with
  `X` and `↑` beside the mascot; another mascot click does not send; `X`
  discards; `↑` commits once; and hold-release remains push-to-talk.
