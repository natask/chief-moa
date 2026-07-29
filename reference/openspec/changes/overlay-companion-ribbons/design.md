# Design notes — Android overlay unit

Companion document to `reference/design/overlay-2026-07/spec.md` and
`parity.md`. This records only what Android forced to differ, and why.

## Files

New, pure Java, unit tested:

| File | Owns |
|---|---|
| `MoaTranscriptVariants.java` | literal / corrected / polished, and which is the default copy |
| `MoaRibbonTokens.java` | every geometry, motion and colour token; two palettes |
| `MoaRibbonBuffer.java` | the sliding-window rule: tail window, retention bound, grapheme-safe truncation |
| `MoaRibbonPresence.java` | the four-state opacity machine, latch and linger deadlines |
| `MoaRibbonUnitLayout.java` | unit placement, the flip rule, drag clamping |
| `MoaOrbRemovalUndo.java` | the reversible-removal window |

New, Android:

| File | Owns |
|---|---|
| `MoaRibbonView.java` | the fixed viewport, the slide, halo/scrim/plate painting, glyph-bounds hit test |
| `MoaRibbonTouchListener.java` | tap / rail-tap / hold / double-tap / drag |
| `MoaRibbonMenu.java` | the ≤4-row hold menu |
| `MoaOverlayUnitController.java` | the three windows, their placement, presence, gestures, copy and menu |

`OverlayService` keeps the voice session, the composer, and the companion's own
gestures, and drives the unit with the current turn's text. It asks the unit
nothing about how that text is painted. That extraction is also what brings the
file back under the source-size ceiling (4222 → 3792 against a 3959 limit); the
ceiling was not raised.

Changed: `MoaOrbOverlayGeometry` (bounded remove target),
`MoaOrbRemoveTarget` (larger painted target, undo chip), `OverlayService`,
`MainActivity` (`EXTRA_SHOW_HISTORY`), `MoaOrbTouchListener` (dormant alpha).

Deleted: `MoaTranscriptSwipePolicy` (+ its test), `MoaVoiceDeliveryToggle`,
`MoaOverlayWindowLayout.transcriptBodyHeight`, `OverlayService.CappedScrollView`,
and the card's view builders (`createVoiceHeader`, `voiceMessageRow`,
`attachSwipeDismiss`, the swipe cascade, `scrollVoiceTranscriptToBottom`).

## Deviations from the spec, and why Android forced them

### 1. The speaker dot lives inside the ribbon window, not outside the box

The spec places the 5dp speaker dot "outside the viewport", to the left of the
ribbon box. On Android a ribbon IS a window; there is no space outside it to
paint into without a fourth window per ribbon. The dot is painted in a 15dp left
gutter inside the window, and the text viewport starts after it. Visually
identical; structurally one window fewer.

### 2. Touch pass-through is per-window, not per-pixel

`parity.md` §2 asks that a touch inside the ribbon rectangle but off the glyph
run fall through to the app underneath. Android cannot do that from a normal
overlay window: an unconsumed touch delivered to a window is dropped, not
forwarded, and the API that would express a sub-window touchable region
(`ViewTreeObserver.OnComputeInternalInsetsListener`) is hidden.

What ships instead:

- A ribbon with no text has `FLAG_NOT_TOUCHABLE` set on its window, so it is
  completely transparent to touch. This is the common case — an idle overlay.
- A ribbon with text is touchable, and `MoaRibbonView.hitsInteractive` still
  rejects anything more than 8dp off the painted glyph run by returning `false`.
  Those touches are swallowed rather than forwarded.

So the occlusion window is: a 340x28dp strip, only while a turn's text is on
screen, only off the glyphs. Resizing the window per frame to hug the glyph run
would forward those touches, but a window whose width changes with content is
exactly the reflow this design exists to prevent.

### 3. `MoaOverlayGroupDragListener` is not the ribbon drag path

`parity.md` says Android keeps that listener and adds the ribbons as surfaces on
its callback. It drags from a *card header* and assumes the card is the thing
being moved. Ribbons have no header and each drag has to write the companion
anchor from a recorded drag-start position, so `MoaRibbonTouchListener` reports
`onDragStart / onDragMove(dx, dy) / onDragEnd` and `OverlayService.dragUnitBy`
applies the delta through `MoaRibbonUnitLayout`. The old listener still drags the
composer panel.

### 4. `Replay` is disabled, and `Record again` takes its row

Spec §7.1 gives the reply ribbon a Replay row. Nothing retains per-turn assistant
audio on the device, so Replay is present and dimmed. When a voice capture failed
and a retry is armed, that row becomes `Record again` — the affordance the card
used to carry as a pill inside the failed reply bubble. Dropping it would have
been a silent functional regression.

### 5. Theme follows `uiMode` only

As `parity.md` requires. Android cannot see the app underneath and must not try;
sampling the screen for a cosmetic decision would be a screen capture requiring a
separate explicit grant.

### 6. Grapheme segmentation differs between the device and the test JVM

`BreakIterator` is ICU-backed on Android and handles ZWJ emoji sequences as one
cluster; the plain JVM the unit tests run on splits them into components. The cap
is 140 clusters and the visible window is geometric, so the difference cannot
change what the user sees. Recorded rather than worked around.

### 7. Tap means expand, and expand is the one thing that may resize

The design contract gives tap "solidify + latch + reveal the copy rail". The
user then asked for click-to-expand on the same element. Rather than split them
across two gestures, tap does all of it: the ribbon expands to the full turn,
solidifies, and shows copy. A second tap collapses.

That means the unit's height changes on tap. The no-reflow invariant survives
intact because it is about STREAMING: a delta may never resize anything. A
deliberate tap may, and the growth is bounded at `EXPANDED_MAX_H_DP` (168dp) with
the same tail rule as the collapsed line, so the overlay still cannot become a
panel.

### 8. Copy variants exist in the UI before they exist in the data

`MoaTranscriptVariants` accepts three forms and defaults to the most polished
present. Today only LITERAL is ever populated — no gateway endpoint produces the
corrected or rewritten forms, and section 3 of `voice-capture-notebook-ime` is
entirely unchecked. The menu therefore shows `Copy polished` and `Copy corrected`
disabled. They are absent, not fabricated.

Variants apply to the you-ribbon only. The reply is already model text, so
"literal versus polished" has no meaning there; its menu keeps a single Copy.
`Copy as note` was dropped from the you-ribbon menu to keep it at four rows, and
`Hide overlay` moved to the reply-ribbon menu — the notification's Hide action
and drag-to-remove are both still available.

## What the tests pin

- `MoaRibbonBufferTest` — tail-not-head windowing, the 140-cluster cap, the
  8,000-cluster retention bound dropping from the front, copy returning the full
  buffer, and truncation never splitting a surrogate pair or a combining
  sequence.
- `MoaRibbonPresenceTest` — all four states and their precedence, that ambient
  paints no plate, latch expiry and early release, linger not starting while
  engaged, and that an empty dormant ribbon takes no touch.
- `MoaRibbonUnitLayoutTest` — that a delta applied to the companion moves both
  ribbons by the same delta (drag-as-one), that ribbons flip instead of pushing
  the companion, that reading order survives a flip, and that the unit's resting
  footprint is a constant.
- `MoaTranscriptVariantsTest` — polished-by-default, graceful degradation to
  literal, and that a derived variant never overwrites the literal transcript.
- `MoaRibbonPresenceTest` / `MoaRibbonUnitLayoutTest` — expansion holds engaged,
  losing the text collapses it, and expansion is bounded at both ends.
- `MoaOrbOverlayGeometryTest` / `MoaOrbRemovalUndoTest` — the armed zone is the
  painted rectangle plus one tolerance, drags that merely pass near the bottom no
  longer arm removal, and undo restores the drag-start position exactly once
  inside a 5s window.
- `MoaWindowLayoutStateTest` — an unchanged collapsed ribbon layout is submitted
  once, while expansion height, position, touchability flags, and a newly shown
  window each require a fresh submission.
- `MoaOverlayGroupDragListenerTest` — eight panel-header move events before one
  display frame request exactly one frame, perform no early orb submission, and
  apply the latest anchor once on that frame.

## Fluidity repair evidence

The 2026-07-27 P0 repair separates ribbon paint/presence work from window
geometry. Streaming text may still invalidate and repaint the `MoaRibbonView`,
but `MoaOverlayUnitController` submits a `WindowManager` layout only when x, y,
width, height, or flags differ from the last submitted state. Show resets the
guard; expansion, configuration changes that alter placement, and drag therefore
still reposition normally.

Panel-header drag now matches orb and ribbon drag: each raw `ACTION_MOVE` stores
only the newest clamped companion anchor and requests the shared
`MoaFrameCoalescer`. The frame callback remains the sole submitter for the orb,
panel, ribbons, and remove-target state.
