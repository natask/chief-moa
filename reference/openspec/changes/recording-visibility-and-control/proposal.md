# Recording Visibility And Control

## Status

Proposal only. Nothing in this change is implemented.

## Why

On 2026-07-18 the gateway recorded a private family conversation on the
Android surface (voice turns `turn_...` at `2026-07-18T08:26:23.903Z` and
`2026-07-18T08:36:27.754Z` in session `shared-usr_74223d7809682c30`, mined
read-only from the production droplet). The user's own reaction, spoken while
still being recorded, was: *"It's been recording all this time? ... Did I
smash the bug?"* They did not know capture was still active. This is a
privacy failure, not a missing feature: a user discovering after the fact that
they were recorded without realizing it is exactly the failure mode a capture
product has to design against deliberately, not leave to be noticed by
accident.

This proposal is scoped narrowly to that failure: making it impossible to be
recorded without a visible, persistent signal, and giving the user an
immediate way to stop and to review/delete what was just captured. It is not a
capture-feature change and it does not touch what gets captured, how
transcription works, or the overlay-redesign's visual language beyond the one
addition this requires.

## Current state (read before implementing)

Read `design.md` in this change for the file:line evidence this proposal is
grounded in. Summary of the two load-bearing facts:

1. **No surface currently starts capture with zero deliberate user act.**
   Every capture start traces back to an explicit gesture (tap, click,
   press/hold) at some point. The one caveat: Android's `continuousVoiceLoop`
   re-arms the microphone after each turn without a *new* gesture, for as long
   as the user stays in an already-explicitly-entered voice loop
   (`OverlayService.java:1536-1549`, `:3900-3915`). This is not "passive"
   capture in the sense of starting unprompted, but it does mean the mic can
   be live again some seconds after the user's last deliberate touch, which is
   consistent with what happened on 07-18.
2. **A visible, capture-distinguishing indicator already exists on both
   surfaces today** — Android's orb violet listening rim
   (`OrbView.java:129-132`, `:239-250`) and steady red recording-note tint
   (`OrbView.java:142-145`, `:223-224`); the browser extension's
   `.listening`/`.recording` CSS classes and mascot hue-rotate
   (`overlay.css:627-644`). **The failure was not the absence of an
   indicator. It was that the indicator was not persistent or salient enough
   to be noticed during a long, low-attention capture, and the browser
   extension's indicator has no fallback when the in-page overlay is not
   what's currently in view (no toolbar-level indicator at all — confirmed no
   `chrome.action.setBadgeText`/`setIcon` call anywhere in `background.js`).**

## What changes

- A recording-active state becomes a first-class state on the **companion**
  element (the orb / mascot), not just the ribbons or cue-card, because the
  companion is the one element the overlay-redesign design contract
  (`reference/design/overlay-2026-07/spec.md`, in the sibling `design-overlay`
  lane) never fully hides. See `design.md` §2 for why the ribbons cannot carry
  this indicator alone.
- The browser extension gains a toolbar-level (`chrome.action`) recording
  badge as a fallback that survives the in-page overlay being out of view,
  scrolled away, or not yet injected in the active tab.
- A single, low-friction action reachable from the recording-active state
  stops capture immediately, on both surfaces.
- A capture-block delete route is added at the gateway
  (`DELETE /v1/capture-blocks/:id`, tombstone semantics — see `design.md`
  §5), and both clients gain a minimal "review the capture that just ended,
  delete it" affordance reachable from the same recording-active state after
  it stops. This is new gateway surface, not a redirect to
  `voice-capture-notebook-ime`'s unbuilt Android notebook (section 2 of that
  change) — this proposal only needs delete-the-most-recent-capture, not a
  browsing library.

## What does not change

- Hosted TTS only. This proposal does not touch `MoaVoiceController.speak()`
  or introduce any local Android `TextToSpeech` path.
- Capture-block storage, retention, and the existing `recovery/` reconciliation
  path stay exactly as they are. Delete is a tombstone (see `design.md` §5),
  not a change to how capture-blocks are stored or recovered.
- This proposal does not delete, redact, or otherwise touch any recording that
  already exists, including the 07-18 turns that motivated it. Retroactively
  scrubbing past captures is a separate, deliberate decision with its own
  risks (a family member's data, evidentiary/legal holds, the recovery
  ledger) and is explicitly out of scope here.
- The overlay-redesign's opacity/transparency contract
  (`dormant`/`ambient`/`engaged`/`dragging` in the sibling design) is not
  replaced. `design.md` §2-3 specifies the one addition to it.
- Capture triggers, gestures, and what starts a turn are unchanged. This
  proposal does not add, remove, or rebind any gesture.

## Capabilities

- `recording-visibility` (new) — see `specs/recording-visibility/spec.md`.
