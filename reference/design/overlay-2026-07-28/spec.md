---
title: Overlay v2 — Companion, capture capsule, bubbles
date: 2026-07-28
status: design-contract
surfaces: browser_extension (content.js, overlay.css, ribbons.css, ribbon-runtime.js,
  quiet-companion-controls.js, offscreen-audio-worklet.js), android_app (OrbView,
  MoaRibbonView, MoaRibbonTokens)
supersedes: reference/design/overlay-2026-07/spec.md §2.1, §4, §5, and the
  `#agee-quiet-controls` pill
direction: migrate the Android surface onto the browser, then push the one new
  element (capture capsule) back to Android
---

# 1. What is wrong today

Four defects, each traced to a line. They are not taste; they are the reasons
the overlay reads as broken.

## 1.1 You cannot tell it is hearing you

The browser paints nothing on the companion while the mic is open. The only
listening style is `#agee-root.agee-voice-first.agee-state-listening
#agee-launcher .agee-bird` (`overlay.css:758`) — a `brightness(1.12)
saturate(1.2)` filter on a 44px PNG, and it is gated behind the `agee-voice-first`
experiment flag, which is off by default. So in the default mode, listening looks
identical to idle.

Android does not have this problem. `OrbView` holds a steady violet rim while the
mic is open, deliberately thicker than the idle hairline, and documents why:
"so 'the orb is hearing me' reads at a glance" (`OrbView.java:32-36`).

Worse, the browser has **no mic level signal at all**. `AggieVoiceCaptureProcessor`
posts raw `Float32Array` blocks straight through to the offscreen document
(`offscreen-audio-worklet.js:10`) and nothing anywhere computes amplitude. There
is no number to drive a waveform, moving ears, or a responsive rim.

## 1.2 The controls cover the companion

`#agee-quiet-controls` is `position: fixed` with its own z-index
(`overlay.css:126-139`) and is positioned every frame at
`launcher.rect.right + 6` (`quiet-companion-controls.js:65-72`). It is not
hover-gated, not part of the draggable unit, and never hides. It is a permanent
second object crowding the mascot — both screenshots show it. When the companion
is near the right edge it flips to the left and lands *on* the mascot.

## 1.3 Black and white at the same time

`--agee-ribbon-scrim` is `rgba(18, 19, 23, 0.92)` in the dark palette
(`ribbons.css:42`) **and identical in the light palette** (`ribbons.css:74`).
`.agee-ribbon-text` then hard-codes `color: #f7f7f8` and a white inset hairline
(`ribbons.css:226-229`).

So on a light page the luminance sampler correctly flips
`data-agee-ribbon-theme="light"` (`ribbon-runtime.js:374`), every ink/plate/halo
token flips light — and the text plate stays near-black with white ink. Half the
unit is dark-mode, half is light-mode, in the same frame. Android's light palette
gets this right: scrim `0x85FFFFFF` (`MoaRibbonTokens.java:136`). The old spec
also specified it right (`overlay-2026-07/spec.md` §9.1, light scrim
`rgba(255,255,255,0.52)`); the implementation drifted.

## 1.4 It is not a bubble

The browser ribbon is one `white-space: pre` line in a fixed 28px box, slid by
`translateX` (`ribbons.css:83-115`, old spec §4). With
`box-decoration-break: clone` on a clipped single line, the scrim renders as a
ragged black band the width of the viewport — image 1.

Android already abandoned this. `MoaRibbonView` is "a compact translucent chat
bubble": it stays at `COLLAPSED_MAX_LINES = 1`, pins to the tail, and expands on
tap to `EXPANDED_MAX_LINES = 3` with vertical scrolling, radius 14dp, width 280dp, 14sp
(`MoaRibbonView.java:20-40`, `MoaRibbonTokens.java:47-77`). And
`MoaRibbonPresence` records the reversal explicitly: "Later visual direction made
the live transcript a deliberate bubble. Ambient therefore paints one compact
translucent plate" (`MoaRibbonPresence.java:8-11`).

**The browser never received that migration.** It is still running the design
Android replaced.

# 2. The product

Three objects. One unit. Nothing else.

```text
              ┌─────────────────────────────┐
        ●     │ how much is the flight to   │   you bubble
              │ Addis in early November     │   (wraps, tail-pinned)
              └─────────────────────────────┘
                          ▲ gap 8
                        ( 🦁 )                  companion
                       listening rim            (the state display)
                          ▼ gap 8
              ┌─────────────────────────────┐
        ●     │ Around 780 round trip if    │   reply bubble
              │ you leave midweek…      ⧉ 🔊│   (rail on engage)
              └─────────────────────────────┘

                   ┌────────────────┐
                   │ ✕  ▁▃▅█▇▄▂▁  ✓ │          capture capsule
                   └────────────────┘          (mic open only)
```

| Object | Exists when | Owns |
|---|---|---|
| **Companion** | always | the state answer: idle / listening / thinking / speaking / recording / error |
| **Capture capsule** | mic is open | live level, discard, commit |
| **You bubble** | there is user text this turn, + linger | live transcript, copy |
| **Reply bubble** | there is assistant text this turn, + linger | streamed reply, copy, mute, replay |

Deleted: `#agee-quiet-controls`. Copy and mute move into the reply bubble's rail,
where they belong to the thing they act on.

# 3. The companion is the state display

This is the headline fix for "I don't even see that it's hearing me". The
companion answers *what am I doing* at a glance, with no text, from any distance.

The mark stays a bare PNG. State is painted as a **rim** — an SVG ring in the
launcher, behind the mark, currently unused markup (`.agee-ring`,
`content.js:321`). One element, six states.

| State | Rim | Mark | Motion |
|---|---|---|---|
| `idle` | none | opacity `0.34` | 6s breathe (unchanged) |
| `listening` | `--agee-you` violet, width `0.06em + 0.05em × level` | opacity `1` | rim width tracks mic level at 24Hz |
| `thinking` | `--agee-amber`, width `0.06em` | opacity `1` | opacity pulse `0.45 → 1`, 1.4s |
| `speaking` | `--agee-gold`, width `0.06em + 0.04em × level` | `saturate(1.5) brightness(1.12)` | rim tracks playback level |
| `recording` | `--agee-red`, width `0.07em`, steady | red tint (unchanged) | none — a note capture must not look like a voice turn |
| `error` | `--agee-ember`, width `0.07em`, steady | opacity `1` | holds 3s, then `idle` |

Rules:

- The rim is drawn **outside** the mark's box (`inset: -0.18em`) so it never
  shrinks the mascot and never changes layout.
- Rim width and opacity are the only animated properties. Both are
  compositor-cheap. No `box-shadow` glow, no halo, no scale-pulse — those read as
  a notification badge, not a creature.
- `listening` is **not** flag-gated. Delete the `.agee-voice-first` scope on
  `overlay.css:758`; the state vocabulary is the default behaviour on both
  surfaces.
- The rim scales with `--agee-mascot-font` like everything else, so scroll-to-resize
  keeps working untouched.
- `prefers-reduced-motion`: level tracking is dropped, each state holds its
  mid-width rim. Colour still distinguishes all six.

**On the "moving ears" idea.** Rejected as the primary signal, kept as an
optional layer. The pet runtime already carries per-part markup
(`.agee-pet-ear-left/right`, `content.js:328-329`) and an `avatar_behavior`
trigger vocabulary including `listening` (`content.js:154`). Ear motion is
therefore free to add for pet companions — but it cannot be the contract,
because the default companion is a flat PNG lion with no ears to move, and
because a 44px mascot's ear travel is invisible at a glance. The rim reads from
across the screen; ear motion is charm on top. Ship the rim; wire
`avatar_behavior` ear motion to the same `--agee-level` var so pets get both.

## 3.1 The mic level pipeline

New, because nothing computes amplitude today. One number, `0..1`, at 24Hz.

1. **Worklet** (`offscreen-audio-worklet.js`): alongside the existing
   `postMessage({samples})`, accumulate `sum += s*s` and emit
   `{level: sqrt(sum/n)}` once per ~42ms (every 8th 128-frame block at 24kHz).
   No extra allocation — reuse the running accumulator.
2. **Offscreen** (`offscreen-voice-bridge.js`): forward as a voice event
   `{type: "mic_level", rms}` on the channel that already carries
   `transcript_partial` (`content.js:2925`).
3. **Content**: normalise with a fast-attack / slow-release envelope
   (`attack 0.6, release 0.12`), map through
   `level = clamp((db + 55) / 40, 0, 1)` so quiet speech still moves the rim, and
   write `root.style.setProperty("--agee-level", level)`.
4. Everything visual reads `--agee-level`. One var, one write per frame, three
   consumers (rim, capsule bars, pet ears).

For `speaking`, the same var is driven from TTS playback. If no `AnalyserNode` is
available on the playback path, fall back to a synthetic `0.35 + 0.25·sin(2.4Hz·t)`
so the rim still lives — a fake level is better than a dead companion, and the
user cannot tell the difference on a 2px rim.

Cost: 24 messages/second while the mic is open, zero when it is not. No new
permission, no new socket.

# 4. The capture capsule

This is the Wispr Flow element. It is the single best thing in that product and
it maps cleanly onto machinery that already exists.

```text
┌──────────────────────────────┐
│  ✕   ▁▃▅█▇▄▂▁▂▄▆█▅▃   ✓      │   134 × 34, radius 999
└──────────────────────────────┘
   28      14 bars, 2px      28
```

| Property | Value |
|---|---|
| Size | `134 × 34px`, radius `999px` |
| Position | centred under the unit, `12px` below the lower bubble (or below the companion when there is no lower bubble) |
| Plate | **always opaque**, both themes: `rgba(18,19,23,0.92)`, `blur(18px)`, inset hairline `rgba(255,255,255,0.12)` |
| Left button | `✕` discard — kills the turn, no transcript sent |
| Right button | `✓` commit — same as release-to-send |
| Bars | 14, `2px` wide, `2px` gap, height `3px + 15px × barLevel`, radius `1px` |
| Bar fill | `--agee-ribbon-ink` (light-theme aware, unlike the plate) |
| Motion | bars shift left one slot per sample (24Hz); newest level enters at the right |
| Lifetime | mounts on mic open, unmounts `180ms` after mic close |

Why the capsule keeps a plate when the bubbles do not: it is a **control**, not
text. Controls need an unambiguous hit target and a stable contrast floor. Text
should melt into the page; buttons should not. This is also why it is the one
element that ignores the page-luminance theme for its fill.

The `✕` / `✓` semantics already exist on Android as
`ACTION_DISCARD_VOICE_DRAFT` / `ACTION_SEND_VOICE_DRAFT` accessibility actions on
the orb (`OrbView.java:38-39`). The capsule makes them visible instead of
TalkBack-only. Android gets the capsule in phase 3 as a new overlay window
anchored by `MoaOrbOverlayGeometry`.

The capsule replaces `#agee-quiet-controls` in position but not in function. The
old pill was always-on and turn-agnostic; the capsule exists only during capture
and acts only on the capture.

# 5. Bubbles — port the Android geometry

Adopt `MoaRibbonView` wholesale. The browser stops being a one-line ticker.

| Token | Browser v2 | Android today | Note |
|---|---|---|---|
| width | `clamp(260px, 40vw, 380px)` | `RIBBON_MAX_W_DP = 280` | browser gets more room; both bounded |
| collapsed lines | `1` | `COLLAPSED_MAX_LINES = 1` | fixed while streaming |
| expanded lines | `3`, scrollable | `EXPANDED_MAX_LINES = 3` | opens only on click |
| radius | `14px` | `RADIUS_RIBBON_DP = 14` | identical |
| padding | `8px 12px` | `RIBBON_PAD_X_DP = 12`, `EXPANDED_PAD_Y_DP = 9` | |
| text | `14px / 20px / 450` | `TEXT_SP = 14` | up from 13px |
| gap to companion | `8px` | `GAP_DP = 6` | |
| buffer cap | `8000` chars | `BUFFER_MAX_CHARS = 8000` | identical; copy reads the buffer |

## 5.1 Streaming behaviour

The user's words: "it should look like a proper bubble and be streaming."

- Text **wraps**. Delete the `white-space: pre` + `translateX` sliding window
  (`ribbons.css:207-210`) and `WINDOW_CHARS = 140`. They were the anti-reflow
  device for a fixed-height box; a bounded-height bubble does that job better.
- The bubble stays one line while streaming and **pins to the tail**: new text
  appears at the bottom and old text leaves above a 12px fade. Width, height,
  and position never change mid-stream.
- A deliberate click opens exactly three visible lines. Longer current-turn text
  scrolls vertically inside that viewport.
- One `requestAnimationFrame`-coalesced write per frame. Deltas append to a text
  node; no `innerHTML`, no re-layout of the whole run.
- A caret (`2 × 16px`, `--agee-ribbon-accent`, 1060ms blink) sits at the tail of
  the receiving bubble. This is the second "it is hearing me" signal: the caret
  appears the instant capture opens, before the first word arrives.
- Interim transcript renders at `--agee-ribbon-muted`; it hardens to
  `--agee-ribbon-ink` on `transcript_final`. You can see it thinking about the
  word.

## 5.2 One plate, always

Reverse old spec §5 ("ambient never paints a filled rectangle"). Android already
reversed it; the per-glyph scrim is what produced the smear.

| State | Bubble |
|---|---|
| `dormant` | opacity 0, not painted |
| `ambient` | **one plate**: `--agee-ribbon-plate` fill, `blur(18px)`, inset hairline, `--agee-ribbon-shadow`. Text at `--agee-ribbon-ink-ambient`. |
| `engaged` | same plate at full opacity, text at `--agee-ribbon-ink`, rail revealed |
| `dragging` | plate at `--agee-ribbon-plate-drag` |

Delete `.agee-ribbon-text` entirely — the per-glyph scrim, the
`box-decoration-break: clone`, the hard-coded `#f7f7f8`, and the text halo. The
plate is the legibility mechanism now. This removes the class of bug in §1.3
rather than repairing one instance of it.

## 5.3 The rail

Revealed on engage, inside the bubble, bottom-right. Three buttons, `24×24`
glyphs in `32×28` hit boxes:

| Bubble | Rail |
|---|---|
| you | `⧉` copy |
| reply | `⧉` copy · `🔊` mute/unmute voice replies · `↺` replay (disabled when no audio retained) |

Mute is a persistent preference and keeps its current wiring
(`setVoiceRepliesEnabled`, `content.js:365`). It moves from the floating pill to
the rail; the preference and its storage key do not change.

# 6. Theme — one palette per frame

The invariant that §1.3 violated, stated so it cannot recur:

> Every painted token in the unit resolves from the palette selected by
> `data-agee-ribbon-theme` for that frame. No element may hard-code a colour.
> No token may carry the same value in both palettes unless it is intentionally
> theme-invariant, and those are listed here.

Theme-invariant tokens, exhaustively: the capture capsule plate, its hairline,
and `--agee-red` / `--agee-green` status colours. Everything else flips.

Corrected light-palette values (match Android):

| Token | Dark | Light | Android source |
|---|---|---|---|
| `--agee-ribbon-plate` | `rgba(18,19,23,0.91)` | `rgba(252,252,253,0.91)` | `plate 0xE8232733 / 0xE8FCFCFD` |
| `--agee-ribbon-plate-drag` | `rgba(18,19,23,0.69)` | `rgba(252,252,253,0.72)` | `plateDrag` |
| `--agee-ribbon-ink` | `#F4F4F6` | `#141519` | `ink` |
| `--agee-ribbon-ink-ambient` | `rgba(244,244,246,0.88)` | `rgba(20,21,25,0.90)` | `inkAmbient` |
| `--agee-ribbon-hairline` | `rgba(255,255,255,0.14)` | `rgba(0,0,0,0.10)` | `hairline` |
| `--agee-ribbon-you` | `#7C8CFF` | `#6474E8` | `you` |

A CI check belongs here: a test that parses `ribbons.css`, collects every
`--agee-ribbon-*` declaration in both palette blocks, and fails when a token is
missing from one block or holds an identical value in both without being on the
invariant list. That is the cheap version of "this can never happen again".

# 7. Gestures — unchanged

The companion gesture map is not touched. Tap, hold, double-tap, triple-tap,
scroll-to-resize, drag all keep their current meaning on both surfaces
(`overlay-2026-07/spec.md` §7 stays authoritative). Bubble gestures gain one
thing: **tap expands** to the bounded scroll, matching Android.

# 8. Phasing

| Phase | Scope | Verify |
|---|---|---|
| **P0** | Light-palette scrim + ink fix (§1.3). Independent of everything else, fixes today's live ugliness. | `npm run verify && npm run smoke` |
| **P1** | Companion rim state vocabulary (§3) + mic level pipeline (§3.1). This is the "I can see it is hearing me" fix. | manual: open mic on a light page and a dark page |
| **P2** | Capture capsule (§4), delete `#agee-quiet-controls`, move copy/mute to the reply rail (§5.3). | `npm run verify && npm run smoke` |
| **P3** | Bubbles: wrap, tail-pin, expand, one plate; delete the sliding window and `.agee-ribbon-text` (§5). | `npm run verify && npm run smoke` |
| **P4** | Parity back to Android: capsule window, companion rim already present. Palette CI check (§6). | `./gradlew assembleDebug` |

P0 through P3 are browser-only. P0 is safe to ship alone and is the largest
visual improvement per line changed.

# 9. Judgment calls

1. **The rim, not the ears, is the listening signal.** Ear motion is invisible at
   44px and impossible on the default flat-PNG lion. The rim is legible from
   across the screen and works for every companion. Ears become a pet-only
   enhancement driven by the same `--agee-level` var. If you want ears as the
   primary signal, the default companion has to become an SVG with parts, which
   is a larger change than this doc covers.
2. **Ambient paints a plate.** This reverses the old spec's central idea. The
   no-plate rule produced the smear, Android already reversed it, and a bubble is
   what you asked for. The cost is that the overlay occludes a little more page
   while text is present. Linger timers keep that window short.
3. **The transcript stays in the you bubble, not a separate top strip.** You
   called a top transcript "kind of nice but not fundamentally important". The
   you bubble already is a top strip that sits with the unit and moves with it. A
   second fixed strip would be a fourth object.
4. **The capsule ignores page theme for its fill.** Controls need a stable
   contrast floor. Its bar fill still flips, so it never reads as a foreign
   dark-mode island.
