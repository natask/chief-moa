# Tasks

## Android lane

- [x] Add `MoaRibbonTokens` with the spec's geometry, motion and colour tokens
      and both palettes.
- [x] Add `MoaRibbonBuffer`: tail window, 140-cluster render cap, 8,000-cluster
      retention dropping from the front, grapheme-safe truncation, full-buffer copy.
- [x] Add `MoaRibbonPresence`: dormant / ambient / engaged / dragging, latch and
      linger deadlines, plate and scrim rules, high-contrast fallback.
- [x] Add `MoaRibbonUnitLayout`: placement from the companion anchor, the flip
      rule, safe-area handling, drag clamping, fixed unit height.
- [x] Add `MoaRibbonView`: fixed viewport, `translateX` slide, left fade mask,
      halo, per-glyph scrim, inset-hairline plate, caret, speaker dot, copy rail,
      glyph-bounds hit test.
- [x] Add `MoaRibbonTouchListener` (tap / rail / hold / double-tap / drag) and
      `MoaRibbonMenu` (≤4 rows, no settings, no model actions).
- [x] Replace the voice card in `OverlayService` with the two ribbon windows;
      keep `voiceLog`, `MoaFrameCoalescer`, the composer, and the companion's
      gesture map unchanged.
- [x] Position all three windows from one anchor every frame; add
      `onConfigurationChanged` re-clamp and flip re-test.
- [x] Bound the remove target to its painted rectangle plus tolerance, enlarge it
      to 200x72dp, and make removal reversible with `MoaOrbRemovalUndo`.
- [x] Route ribbon double-tap to `MainActivity` via `EXTRA_SHOW_HISTORY`.
- [x] Delete the card's builders, the swipe policy, the delivery toggle, and the
      capped scroll view.
- [x] Unit tests for the sliding-window rule, the opacity state machine, the
      drag-as-one grouping, and the bounded remove target.
- [x] `assembleDebug` and `testDebugUnitTest` green; coverage ratchet still met.

## Open

- [ ] Manual phone QA: streaming legibility over light and dark apps, the
      ribbons' hit region against a real app underneath, drag feel across all
      three windows, and the undo chip.
- [ ] Browser lane: `content.js` + `overlay.css` to the same contract, removing
      `.agee-cue`, `#agee-log`, `#agee-voice-state`, `#agee-page-context`.
- [ ] Decide whether the Voice/Text delivery toggle needs a home in the full app
      now that the overlay no longer carries it.
- [ ] Retain per-turn assistant audio so the reply menu's `Replay` row can be
      enabled.
