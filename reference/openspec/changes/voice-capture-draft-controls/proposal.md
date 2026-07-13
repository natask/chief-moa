## Why

Stopping speech currently means either committing a turn or canceling a turn
that still leaves incomplete canonical history. The user needs a third object:
unsubmitted speech that can be paused, parked, resumed, discarded, or
explicitly sent without provoking a response merely because capture stopped.

## What changes

- Add a resumable pre-execution `voice_draft`, distinct from voice turns and
  storage-only audio notes.
- Add voice-first directional hold outcomes: release/send, left/pause,
  up/park, down/discard.
- Make OS/browser cancellation discard/no-execute, never send.
- Defer provider creation and canonical turn storage until explicit send.
- Preserve legacy gestures and old clients through additive protocol fields.

## Non-goals

- Do not relabel audio notes as drafts.
- Do not change ordinary `cancel_turn` evidence-retention semantics.
- Do not add raw-audio playback or a full draft browser in the first slice.
- Do not claim provider billing stops unless no provider session was created.

## Impact

- Gateway draft store, voice WebSocket controls, health capability, smokes.
- Android orb/controller/socket and browser mark/background/offscreen capture.
- Architecture, gesture copy, and cross-surface QA.
