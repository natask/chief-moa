# Cross-Surface Session History

## Status

Proposed as the first coherent recovery wave for the current product direction.
This change defines a narrow implementation target; each source-changing ticket
still requires its own verification, commit, artifact, and promotion evidence.

## Source Intent

The current user direction is to recover a recent long Android-authored message,
make the product's interaction history visible again, and let work continue
without requiring the user to remain inside a chat session. The exact recovered
source is the tracked
[Android product-direction voice note](../../../scratch/agent-loop/android-product-direction-voice-note-20260716.md),
and this change keeps an OpenSpec-owned
[source evidence map](source-evidence.md) so its product outcomes remain linked
to the implementation wave.

This change preserves four parts of that direction:

- the user's phone and browser messages must not disappear into surface-local
  transient state;
- Android and browser must show the same gateway-owned conversation evidence;
- the user must be able to leave the interaction surface while durable work and
  status remain inspectable; and
- development and QA must not interrupt the user's foreground browser, phone
  session, recording, voice turn, or other work.

## Why

Chief Moa already stores voice turns, typed turns, broker events, browser turns,
agent-run references, and receipts through several gateway paths. The browser
also has two competing presentation shapes: a deliberately transient on-page
overlay and an extension-owned side panel that can render message cards. Android
has a compact overlay and a full application intended for deeper inspection.

The missing product seam is a canonical, mixed-source session-message projection
that both durable inspection surfaces can consume. Without that seam, a stored
Android turn can be difficult to find from the browser, browser interaction can
look as though it vanished when the transient cue retires, and each client risks
inventing its own partial conversation history.

## What Changes

- Add one authenticated gateway projection for ordered, mixed-source session
  messages across Android and browser text/voice turns.
- Preserve stable message, session, branch, turn, source, speaker, timestamp,
  completion, and downstream evidence references while deduplicating records
  mirrored through more than one gateway store.
- Make the browser side panel the durable browser interaction workspace. It
  loads canonical messages, shows current progress and terminal results, and
  recovers after an extension service-worker or side-panel restart.
- Keep the on-page browser overlay transient: current intent, current/latest
  result, page identity, voice state, and an explicit handoff to durable history.
- Add canonical session history to the full Android app while keeping the
  floating overlay small and interruption-safe.
- Permit read-only visibility of already-existing browser action receipts in
  message history, without expanding CDP or browser-action authority.

## Non-Goals And Explicit Follow-Ons

The following outcomes remain part of the product direction, but are staged
after this recovery wave rather than silently dropped:

- continuous outbound worker execution, project/intent mapping, durable
  completion objectives, and recurring agent operation;
- macOS surface parity after the shared history contract is stable;
- a supported Windows surface;
- an iPhone/iOS product surface beyond the current protocol/library seam;
- comparative STT and voice-provider evaluation;
- cursor-complete or time-window history export and historical intent review;
- Android overlay/native/remove ergonomics and remaining physical-phone gesture
  QA;
- multimodal presentation input, including explicitly granted image, slide,
  document, and video evidence; and
- new browser action/CDP methods, broader browser delegation, or changed local
  approval classes.

This change does not transcribe raw record-mode audio notes, launch workers,
change project ownership, add a background scheduler, execute browser actions,
or promote a deployment merely because historical intent was recovered.

## User Outcome

The user can submit a long message from Android, leave the interaction surface,
and later find the same complete message and response in both the Android full
app and the browser side panel. The compact overlays remain fast and transient,
while durable work/status references remain attached to the canonical message.

## Success Criteria

- One Android-authored long message and one browser-authored message appear in
  one stable ordered session projection without duplicate broker/turn copies.
- The browser side panel recovers that projection after restart and does not
  rely on content-script memory as conversation authority.
- The Android full app renders the same messages and identifiers while the
  Android overlay remains a compact current-turn surface.
- Incognito turns, unauthorized sessions, and cross-session records do not leak
  into the projection.
- Isolated verification proves the flow without activating a background browser
  tab, reloading the user's active extension, installing an APK, or restarting
  the production gateway during active work.
