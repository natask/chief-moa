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
- [x] N3: tap expands the bounded ribbon to the full turn with the copy
      affordance reachable; a second tap collapses it. Expansion is the only
      thing allowed to change the unit's height.
- [x] N4: `MoaTranscriptVariants` — literal / corrected / polished, polished as
      the default copy, absent forms shown disabled rather than fabricated.
- [x] Extract the unit into `MoaOverlayUnitController` so `OverlayService` drops
      back under the source-size ceiling.
- [x] Bound hands-free capture: `MoaContinuousCaptureLoop` ends the loop after
      five consecutive silent turns or 45 minutes, releases the microphone on
      both exits, and leaves the user able to re-arm with the normal gesture.
- [x] Route every `continuousVoiceLoop` assignment through one setter so the
      bound cannot be left armed behind an existing exit path.

## Open

- [x] Browser visual-QA loop: capture the real extension's collapsed,
      expanded, and copy states in Chrome for Testing; run two Opus critique
      and refinement rounds; preserve model metadata, screenshot hashes, and
      dispositions; receive final visual acceptance. The separate History
      handoff is source-verified but still lacks a rendered screenshot.
- [ ] Manual phone QA: streaming legibility over light and dark apps, the
      ribbons' hit region against a real app underneath, drag feel across all
      three windows, and the undo chip.
- [ ] Browser lane: `content.js` + `overlay.css` to the same contract, removing
      `.agee-cue`, `#agee-log`, `#agee-voice-state`, `#agee-page-context`.
- [ ] Decide whether the Voice/Text delivery toggle needs a home in the full app
      now that the overlay no longer carries it.
- [ ] Produce the corrected and polished transcript variants. Nothing emits them
      today, so the UI degrades to literal-only. Section 3 of
      `voice-capture-notebook-ime` is the contract.
- [ ] Confirm the expand gesture matches whatever the browser lane settles on.
- [ ] Confirm the two capture bounds against how the user actually works. They
      are deliberately generous and may want tightening or loosening.
- [ ] `recording-visibility-and-control` owns the persistent recording indicator
      and the delete affordance. This change only bounds the loop.
- [ ] Retain per-turn assistant audio so the reply menu's `Replay` row can be
      enabled.
