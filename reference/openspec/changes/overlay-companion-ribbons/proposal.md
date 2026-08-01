# Overlay Companion And Ribbons

## Status

Android and browser ribbon presentation lanes implemented. Cross-surface visual
acceptance remains incomplete until the full deterministic state matrix and
real-phone Android QA are captured.

The Android overlay and browser extension now render the companion-and-ribbons
unit defined in `reference/design/overlay-2026-07/spec.md`. Retained partial
visual evidence shows the intended compact streaming, bounded expansion, and
copy states, but it does not prove the complete parity matrix.

## Why

The overlay answered "show the user what is happening" with a **card**: a filled,
bordered, elevated, scrolling rectangle anchored above the orb. A card has a
background, so it occludes. It wraps, so it reflows. It stacks, so it grows. On a
phone it ate the screen.

Two specific consequences were reported and never fixed:

1. On 2026-07-16 and again on 2026-07-23 the user reported that overlay text and
   messages **cover the persistent transcript line**, and asked for a cap so the
   line stays visible. No cap shipped. The card kept growing with each turn.
2. The orb's drag-to-remove hit zone was reported as **too sensitive and too
   small** (open task 2.4 in `voice-capture-notebook-ime`). Drag-to-remove
   shipped; the bounded, reversible target did not. A 150x58dp painted pill had a
   270x170dp invisible hit zone around it, and dropping on it destroyed the
   overlay with no way back.

The user's own statement of what they want:

> "all of it should be basically transparent unless I'm personally pressing down
> on something... I should be able to move any item and the whole unit moves as
> one... tapping it makes it come to life and I can see a copy icon and I can
> press that... holding brings up that menu... if I double click on the text box
> I should open all the chat history and scroll through it... The UI right now is
> completely utterly shit."

## What Changes

The presentation contract changes; the mechanisms do not. The mascot/pet runtime,
the group drag, the streaming transcript plumbing, the companion's gesture map,
and `MoaFrameCoalescer` are all reused unchanged.

- **The unit.** The overlay is one unit of three windows: `ribbonYouView` above,
  the companion (`orbView`) in the middle, `ribbonReplyView` below. Every
  element's position derives from the companion's stored `orbParams.x/y`, so
  existing persistence needs no migration.
- **The ribbons.** Each ribbon is a fixed 36dp-tall, ≤280dp-wide viewport holding
  ONE line. It never wraps, never grows, never reflows. When the line outgrows
  the viewport it slides left so the newest glyph stays pinned at the right inner
  edge. This is the cap the user asked for twice.
- **Visual QA refinement.** The Android viewport is now a 36dp translucent
  bubble with a 14dp radius and a 6dp gap to the production-default 67dp
  companion. It keeps the one-line tail window and bounded tap expansion. This
  supersedes the earlier ambient no-plate treatment after the user explicitly
  asked for the streaming text to read as a bubble.
  Tap expansion is a fixed three-line viewport. Longer current-turn text scrolls
  inside it; the full app remains the history surface.
- **Transparency.** A ribbon with current text paints one compact translucent
  bubble. An empty ribbon still paints nothing and takes no touch at all.
- **Drag as one.** Companion and both ribbons are drag handles. A drag writes the
  companion anchor; all three windows follow in one coalesced frame. The
  companion never moves to make room for a ribbon — the ribbons flip instead.
- **Gestures.** Ribbon tap expands the bounded ribbon to the full turn and
  surfaces its copy affordance; a second tap collapses it. Hold opens a ≤4-row
  menu. Double-tap opens History as a separate surface. The companion's gesture
  map is untouched.
- **Copy is three variants.** Literal, corrected, and polished, with polished as
  the default. Nothing produces the derived forms yet, so this degrades to
  literal-only and says so rather than fabricating them.
- **Removal.** The hit zone is now the painted 200x72dp target plus 12dp of
  tolerance, and a dropped removal is reversible for 5s through an undo chip that
  restores the companion where the drag started.

### Removed from the overlay

The card's chrome went with the card: the voice header, the run-status meta line,
the language line, the Voice/Text delivery toggle, the Hide and Close pills, the
per-row Copy pill, the stacked bubbles, and swipe-to-dismiss. Deep inspection,
history, settings, and approvals belong in the full app. Settings remain
agent-opened only — the overlay exposes no settings entry point.

The Voice/Text delivery toggle is the one user-facing control this removes
outright. Delivery mode remains changeable by voice (`response_modality`,
"be quiet"), but it no longer has a tap affordance anywhere. Flagged for the
user's call.

## Later instructions folded in

Two refinements the user gave on 2026-07-27, after the design contract was
written:

- **Bounded bar with click-to-expand.** The fixed single-line streaming window
  stays; a tap opens exactly three scrollable lines. This competes with the contract's tap-to-solidify,
  so the two are merged: tap expands AND solidifies AND reveals copy. Expansion
  is the one thing permitted to change the unit's height, because the user asked
  for it explicitly; a stream delta still may not.
- **Three copy variants, polished by default.** Built to the derived-revision
  contract in section 3 of `voice-capture-notebook-ime` rather than as a parallel
  concept: the literal transcript is preserved untouched and the derived forms
  sit beside it.

The design lane was updating `reference/design/overlay-2026-07/spec.md` while
this landed; that update was not in this worktree, so the resolutions above are
this lane's and may need reconciling with the browser lane.

### Not done

- Full nine-state cross-surface visual capture and semantic parity acceptance.
- Android real-device/emulator screenshots and manual phone interaction QA.
- A rendered browser History-surface screenshot; only the handoff is
  source-verified today.
- Per-pixel touch pass-through inside a ribbon's own rectangle. See
  `design.md` for why and what ships instead.
- `Replay` of a turn's assistant audio: the menu row exists and is disabled,
  because no per-turn audio is retained on the device today.
- The corrected and polished transcript variants themselves. No gateway endpoint
  emits them, so `MoaTranscriptVariants` accepts three and reports two absent.
