---
title: Overlay redesign — Android / browser parity
date: 2026-07-27
status: design-contract
companion: spec.md
---

# What must be identical

These are the parts of the design that make it feel like one product. A
difference here is a bug.

| Concern | Contract |
|---|---|
| Anatomy | Two ribbons + one companion, ribbon-you above, ribbon-reply below. |
| Ribbon height | `28dp` / `28px`. Constant in every state. |
| Sliding window | Tail window. Geometric right-anchoring + `WINDOW_CHARS = 140` cluster cap + `BUFFER_MAX_CHARS = 8000`. Same numbers, same grapheme-safe truncation. |
| Ambient has no plate | Halo + per-glyph scrim only. Neither surface paints a filled bar until the user is touching the unit. |
| Gesture map | tap / hold / double-tap / drag mean the same thing on the same element. Companion gestures are unchanged from the existing voice-first contract on both surfaces. |
| Thresholds | `HOLD_MS = 340`, `MULTITAP_MS = 260`, latch `6000ms`, linger `4500 / 9000ms`. |
| Drag | Every element is a handle. The anchor is the companion. The unit moves as one. Never snaps to an edge. |
| Colour and type tokens | Same values, expressed as CSS custom properties and as `MoaRibbonTokens` constants. |
| Copy | Copies the full buffer, never the visible window. |
| History | Double-tap opens a **separate** surface. The overlay never becomes a scrollback on either platform. |
| No settings entry point | Neither surface exposes settings from the overlay. Settings change only through the agent's `update_agent_profile` tool. |

# What must differ, and why

## 1. Input model

| | Browser | Android |
|---|---|---|
| Pointer | `PointerEvent`, with hover | `MotionEvent`, no hover |
| Proximity pre-light (`dormant` → 0.7) | **Yes** — `pointermove` within 72px | **No** — there is no hover. `dormant` → `engaged` on touch is the only path. |
| Dormant companion opacity | `0.34` | `0.18` (the existing `orbView.setAlpha(0.10f)` is too faint to find; `0.18` is the new floor) |
| Slop | fixed `6px` | `ViewConfiguration.getScaledTouchSlop()` — device-dependent by design |
| Haptics | none | `HapticFeedbackConstants.LONG_PRESS` at HOLD_MS, `CONTEXT_CLICK` on copy |
| Keyboard | Ribbons are focusable and tabbable; Enter = tap, Space held = hold menu, Escape closes the menu | No keyboard path; TalkBack uses custom accessibility actions ("Copy", "Open history") on each ribbon |

Android must expose the hold-menu rows as `AccessibilityNodeInfo` custom
actions, because a TalkBack user cannot perform a long press on a floating
window reliably. The browser gets the same coverage from focus + keyboard.

## 2. Coordinates and windowing

**Browser** — one `#agee-root` fixed-position layer, page coordinates, viewport
units. The unit is a single DOM subtree; ribbons are children and are positioned
by CSS relative to the companion. The whole unit moves with one transform.
Existing persistence key `ageeLauncherPos` is unchanged.

**Android** — three separate `WindowManager` windows (`orbView`, `ribbonYouView`,
`ribbonReplyView`), screen coordinates in raw px, each with its own
`LayoutParams`. Moving "the unit" means writing three sets of `x`/`y` in the same
frame. Use the existing `MoaFrameCoalescer` so a drag issues one
`updateViewLayout` batch per frame per window; three uncoalesced windows tearing
against each other during a drag is the single most likely way this design goes
wrong on Android.

Ribbon windows must carry `FLAG_NOT_FOCUSABLE | FLAG_NOT_TOUCH_MODAL |
FLAG_LAYOUT_IN_SCREEN` and, in `dormant`/`ambient`, also
`FLAG_NOT_TOUCHABLE` — this is how "does not occlude" is *actually* enforced on
Android: a touch in ambient must reach the app underneath, not the overlay.
`FLAG_NOT_TOUCHABLE` is cleared only when the state machine wants the ribbon to
receive input. In practice:

- `dormant`, `ambient` → ribbons `NOT_TOUCHABLE`; only the companion takes touch.
- The companion's own touch, or a proximity-free tap on the companion, is what
  can raise a ribbon to `engaged`... which is a problem: a ribbon that is
  `NOT_TOUCHABLE` cannot be tapped to solidify. Resolution: ribbons keep a
  **narrow touchable strip** — the ribbon window stays touchable but the
  `OrbView`-style hit test rejects any touch that is not within the painted
  glyph run's bounding box inflated by 8dp. Outside that box, `onTouchEvent`
  returns `false` and the event falls through to the app below. An empty ribbon
  therefore has a zero-area hit region and is fully transparent to touch.

The browser has no equivalent problem: `pointer-events: none` on the viewport
plus `pointer-events: auto` on the glyph-run span gives the same result
declaratively.

## 3. Safe areas and insets

| | Browser | Android |
|---|---|---|
| Top | none beyond `--moa-edge-margin`; the unit may sit under a site's sticky header, which is acceptable because it is transparent | status bar / display cutout via `WindowInsets.Type.statusBars() \| displayCutout()` |
| Bottom | `env(safe-area-inset-bottom)` (already used by `#agee-launcher`) | navigation bar / gesture inset via `WindowInsets.Type.navigationBars()`, plus the existing drag-to-remove zone |
| Sides | `env(safe-area-inset-left/right)` | cutout insets in landscape |
| IME | not applicable to the ribbons (they are not editable); the composer keeps `SOFT_INPUT_ADJUST_NOTHING` | the ribbons must **not** move for the IME. Only the composer window reacts to the keyboard. |
| Rotation / resize | `resize` + `visualViewport` listeners re-clamp and re-run the flip test | `onConfigurationChanged` re-clamps and re-runs the flip test |

The Android drag-to-remove target at bottom-centre is Android-only and is
retained. The browser has no equivalent; hiding is a menu row there.

## 4. Theme selection

**Browser** samples the page. The ambient glyphs sit directly on page content,
so `prefers-color-scheme` alone is wrong on a light page in a dark OS. Rule:
compute the effective background behind the unit's bounding box once per
placement change (drag end, resize, first paint) by walking up from
`document.elementFromPoint` at the unit's centre until a non-transparent
`background-color` is found, falling back to `<body>` then `<html>` then the OS
preference. Relative luminance ≥ 0.55 → light tokens. Re-sample is debounced to
250ms and never runs during streaming.

**Android** follows `Configuration.uiMode` only. It cannot see the app
underneath and must not try to; screen sampling for theming would be a screen
capture, which requires a separate explicit grant and is out of scope for a
cosmetic decision. Android therefore accepts that a dark overlay may sit over a
light app — mitigated by the halo, which is bidirectional enough to stay legible.

## 5. Permission and capability constraints

| Capability | Browser | Android |
|---|---|---|
| Copy | `navigator.clipboard.writeText`, requires a user gesture — satisfied by the tap/menu row. Falls back to the existing `copyTextToClipboard` helper in `content.js`. | `ClipboardManager`, no permission. Android 13+ shows its own copy confirmation; do not add a second one. |
| Blur | `backdrop-filter`, universally available in the target Chrome | `RenderEffect` API 31+ only; below 31 raise plate alpha (spec §9.3) |
| Audio replay | plays through the existing offscreen document | plays through `MoaVoiceController`; **never** local `TextToSpeech` (existing hard rule) |
| History handoff | `chrome.sidePanel.open` — requires a user gesture, satisfied by the double-tap | `startActivity` with `FLAG_ACTIVITY_NEW_TASK`; overlay stays alive behind |
| Occlusion | CSS `pointer-events` | `FLAG_NOT_TOUCHABLE` + glyph-bounds hit test (§2) |
| Existence | the extension is injected per page; a navigation rebuilds the unit and must restore position, scale, and any in-flight ribbon buffer from extension state | the overlay is a foreground service and survives app switches; buffers live in `OverlayService` |

## 6. Streaming source differences

Both surfaces consume the same gateway events (`transcript_partial`,
`transcript_final`, `assistant_text`, `assistant_audio_segment`, `turn_done`).
The mapping to ribbons is identical:

| Event | Ribbon | Effect |
|---|---|---|
| capture starts | you | ribbon → `ambient`, speaker dot pulses, buffer cleared |
| `transcript_partial` | you | append delta, slide |
| `transcript_final` | you | replace buffer with the merged final, slide once, stop the caret |
| first assistant delta | reply | ribbon → `ambient`, buffer cleared, caret on |
| assistant deltas | reply | append, slide |
| `turn_done` | both | freeze buffers, start linger timers, caret off |
| `turn_done` with `tts_spoke:false` | reply | append the existing `(not spoken)` cue in `--moa-warn`, and extend `--moa-linger-reply` to `14000ms` — the user has to read it rather than hear it |
| `turn_done{status:"error"}` | reply | show the error text in `--moa-warn`; linger `14000ms` |
| `no_speech` | you | show "didn't catch that" in `--moa-muted`; linger `4500ms` |

The browser additionally has the desktop-dictation path, which is
transcription-only: it drives the **you** ribbon and never the reply ribbon,
and its terminal state attaches the copy rail automatically (this replaces
`attachDictationCopyAction`'s cue button). Android has no dictation path.

Android additionally has record mode, which drives neither ribbon: it opens no
voice session, so the ribbons stay `dormant` and the existing record affordance
is unchanged.

# Implementation seams

Two lanes, disjoint files:

**Browser lane** — `browser_extension/extension/content.js`,
`overlay.css`, `manifest.json` (side-panel permission if not already present).
Removes: `.agee-cue` rendering path, `#agee-log`, `#agee-voice-state`,
`#agee-page-context`. Keeps: `startLauncherDrag`, mascot scale, pet/avatar
runtime, `setTranscript`, the voice session state machine, the composer.

**Android lane** — `android_app/.../OverlayService.java`, new
`MoaRibbonView.java`, new `MoaRibbonTokens.java`, updated
`MoaOrbOverlayGeometry.java` (add the flip rule; keep `anchoredSurface` for the
composer). Removes: `showTranscriptCard`, `voiceTranscriptScroll`,
`voiceTranscriptColumn`, `createVoiceHeader`. Keeps:
`MoaOverlayGroupDragListener`, `MoaFrameCoalescer`, `MoaOrbTouchListener`,
`OrbView`, the pet visual state, the composer, drag-to-remove.

Neither lane touches the gateway. No wire-protocol change is required by this
design.

Verification stays the repo default: `cd browser_extension && npm run verify &&
npm run smoke` for the browser lane, `cd android_app && ANDROID_HOME="$HOME/Library/Android/sdk"
./gradlew assembleDebug` plus `MoaOrbOverlayGeometryTest` for the Android lane.

# 2026-07-29 revision: what Android still owes

The browser landed the revised contract (spec §3.1 seam, §4.1 reading pace,
§4.2 text mode, §4.3 copy disposition, §4.4 five-line cap). Android implements
the same rules or the surfaces have diverged. Nothing here is optional and
nothing here is browser-specific — the user asked for one interface across
surfaces, so this is a parity debt, not a backlog idea.

| Rule | Browser | Android | Owed |
|---|---|---|---|
| Seam: you-box left edge on the companion centre line, reply-box right edge on it, mirroring near an edge | done (`ribbon-layout.js` `ribbonPlacement`, unit-tested) | not started — both ribbons still centre on the orb | port the `onSeam(preferred, mirrored)` rule into `MoaOrbOverlayGeometry` and cover it in `MoaOrbOverlayGeometryTest` |
| Words anchored to the seam edge (and the speaker dot to the opposite one) | done (`youSeam`/`replySeam` + `[data-agee-seam]` CSS) | not started | anchor the ribbon text to the seam edge; without this the seam alone looks worse than centring |
| Reading pace: `target`/`buffer` split, 26 grapheme clusters/s, 2.5s catch-up, reply only, copy reads `target` | done (`ribbon-runtime.js`) | not started — a whole reply still lands at once | port the reveal timer into the ribbon view; keep it off the user line |
| A turn is not visually over until the reveal is (parked linger) | done | not started | same lane as the reveal timer |
| Text mode is the you-line, not a panel | done (`beginCompose`) | not started — `showPanel` still raises the composer | make the user ribbon editable; leave `panelView` for approvals/notes |
| Copy during live capture finalizes WITHOUT sending | done (`finalizeUserTranscriptForCopy` cancels, never commits) | **diverges** — `OverlayService` requests *commit*, which sends the turn | change the Android path to cancel-and-copy; the user's rule is "copy must not send" |
| Opened box capped at five lines | done (CSS `calc(5 * line-h)`) | not started | apply the same cap to the expanded ribbon view |

Android's advantage worth porting the other way: it waits for the provider's
final transcript before writing the clipboard, so the copy is authoritative
rather than a partial hypothesis. The browser cannot do that today without
sending the turn (`transcription_only` is a session-start flag, not a mid-turn
one). Reconciling that needs a gateway change — a commit that returns the final
transcript and runs no model — and is the one item here that is not client-only.
