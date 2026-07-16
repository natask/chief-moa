# Voice-First Orb Gestures

## Current Browser Contract (Accepted 2026-07-16)

- First single click starts current-thread capture; the next single click stops
  and sends it exactly once.
- Double-click starts fresh-thread capture while the foreground response keeps
  generating with its device audio suppressed.
- Either a single click or another double-click stops and sends that fresh turn.
- Triple-click opens chat without cancelling active capture or generation.
- Hold and release remains push-to-talk.
- This mapping is canonical. It has no experimental flag, user-visible gesture
  setting, click-to-type fallback, or review-draft side controls.
- A microphone error remains visible in the current surface and never opens
  Options automatically.

This is extension-owned interaction state and requires no gateway change.

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

- Single click/tap: start a reviewable draft in the current voice thread. The
  overlay immediately shows `X — orb/mascot — ↑`, with discard on the left and
  the one affirmative Send action on the right. A later orb or mascot tap never
  commits the draft; disposition stays visible and reversible beside the mark,
  independent of any transcript card above or below it.
- Double-click, quick: start a fresh voice thread. If the first click armed
  the current thread or deferred a send, that loop is cancelled first; the new
  turn rides the existing one-shot `context_action:"new"` path so it keeps
  standing facts but does not include the current thread's replies.
- Triple-click, quick: opens the chat/text surface (demoted, still reachable).
  If the double-click started a fresh loop milliseconds earlier, that loop is
  cancelled first so chat never leaves a hot mic.
- Single press-and-hold, still: push-to-talk. Mic warms at press-down where
  the surface supports it; release commits the turn. Movement past the drag
  slop before the hold threshold stays a drag, and a large movement after the
  hold confirms cancels the capture and escapes into a drag (hold-then-move
  muscle memory).
- Fourth click and beyond: nothing.
- Drag repositions the orb and its open card together. The card docks wholly
  above the orb when it fits and otherwise flips wholly below it.
- Dragging the orb into the bottom removal target and releasing hides the orb
  and stops the overlay service. The chat header and foreground notification
  expose a second explicit Hide action.

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
- A single click never silently commits a draft. The user can keep speaking,
  cancel, or explicitly send from the visible controls.
- A still press-and-hold remains push-to-talk; release commits immediately.
  This preserves the fast eyes-free path on both surfaces while the click path
  favors review and correction.
- Android and browser use the same visible draft states and meanings:
  `X — orb/mascot — Send`. `X` always discards and `Send` always commits; a
  transcript or chat card above or below never owns those actions.
- Multi-click mappings are not changed by this revision until their collision
  with the new single-click review state is designed and tested. In particular,
  double, triple, and fourth clicks must not accidentally send a pending draft.

The user aligned this revision for Android implementation and deployment on
2026-07-14, then clarified that the same geometry and behavior must ship in the
desktop browser extension.

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

## Proposed Review-Before-Send Revision (2026-07-14, Pending Alignment)

The next product revision makes the cheapest gesture consistent and visibly
reversible on Android and in the browser:

- A single click starts a voice draft and immediately exposes two controls:
  `X` to cancel/discard and one affirmative `Send` control to commit. The
  affirmative control may use a send arrow or a check/yes treatment, but it is
  one semantic action rather than separate Yes and Send actions.
- A single click never silently commits a draft. The user can keep speaking,
  cancel, or explicitly send from the visible controls.
- A still press-and-hold remains push-to-talk; release commits immediately.
  This preserves the fast eyes-free path on both surfaces while the click path
  favors review and correction.
- Android and browser use the same visible draft states and meanings. Layout
  may adapt to each surface, but `X` always discards and `Send` always commits.
- Multi-click mappings are not changed by this revision until their collision
  with the new single-click review state is designed and tested. In particular,
  double, triple, and fourth clicks must not accidentally send a pending draft.

This revision supersedes the current single-click start/send toggle if accepted.
It does not authorize implementation yet.

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

Android retains its `MoaPrefs` boolean `voice_first_gestures`. The browser has
no gesture flag or user-visible gesture setting.

## Non-Goals

- No chat removal yet; triple click keeps it reachable.
- No change to the Cmd+./Cmd+, hotkeys (they already match the proposed shape).
- No gateway, voice-session protocol, or provider changes.
- Android default behavior remains a separate surface decision.

## Boundaries

- Android and the browser extension own gesture detection and local UI state.
- The gateway voice contract is reused untouched.
- Android keeps its existing flag boundary; the browser mapping is unconditional.

## Verification

- Browser extension: `cd browser_extension && npm run verify && npm run smoke`.
- Android: `cd android_app && ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew assembleDebug`.
- Android manual QA with the flag on: single click starts a draft with visible
  `X` and `↑`; only `↑` sends; `X` discards; a later orb tap does not send;
  double-click starts a new voice thread; triple-click opens chat; hold-to-talk
  release commits; open cards remain wholly above or below the moved orb; and
  dragging onto Remove hides the orb. Flag off restores the legacy gestures.
- Browser manual QA: one mascot click starts capture and the next single click
  sends it once; double-click starts a fresh capture and either a single click
  or another double-click sends it once; triple-click opens chat without
  cancelling active work; hold-release remains push-to-talk; and microphone
  denial reports in place without opening Options.
