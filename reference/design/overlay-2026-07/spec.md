---
title: Overlay redesign — Companion + Ribbons
date: 2026-07-27
status: superseded-in-part
superseded_by: reference/design/overlay-2026-07-28/spec.md — §2.1 (ribbon
  internals), §4 (sliding window) and §5 (ambient paints no plate) are replaced
  by the bubble contract. §3, §6, §7 and §8 remain authoritative.
surfaces: android_app (OverlayService), browser_extension (content.js, overlay.css)
supersedes_visually: the cue-card stack (.agee-cue), the voice transcript card
  (OverlayService.showTranscriptCard), the panel-as-default-open behaviour
---

# 1. What this replaces and why

Today both surfaces answer "show the user what is happening" with a **card**: a
filled, bordered, elevated rectangle anchored above the orb (`.agee-cue` in the
browser, `transcriptView` on Android). A card has a background, so it occludes.
It wraps, so it reflows. It stacks, so it grows. On a phone it eats the screen.

The replacement keeps every mechanism that already works — the mascot/pet
runtime, the group drag, the streaming transcript plumbing, the always-above
anchoring maths — and changes the *presentation contract*:

> The overlay is a **companion between two ribbons**. A ribbon is one line of
> text with no surface behind it. It never wraps, never grows, never reflows.
> Nothing in the unit paints a filled background until the user is physically
> touching it.

This is not a chat window. It shows the current turn only. History is a
different surface that the overlay *opens*; the overlay never becomes a
scrollback.

# 2. Component anatomy

The overlay is exactly one **unit** with three elements, stacked and
horizontally centred on the companion:

```text
        ┌──────────────────────────────────────┐
  YOU   │ …ow much is the flight to Addis in   │   ribbon-you   (top)
        └──────────────────────────────────────┘
                          ▲ gap 8
                        (🦁)                        companion    (middle)
                          ▼ gap 8
        ┌──────────────────────────────────────┐
  A.G.  │ Around 780 dollars round trip if you │   ribbon-reply (bottom)
        └──────────────────────────────────────┘

        └───────────── one draggable unit ─────┘
```

| Element | Id (browser) | Android view | Owns |
|---|---|---|---|
| `unit` | `#moa-unit` | `orbView` + two ribbon windows | position, drag, opacity state |
| `ribbon-you` | `#moa-ribbon-you` | `ribbonYouView` | live user transcript (partial + final) |
| `companion` | `#agee-launcher` (unchanged) | `orbView` (unchanged) | voice gestures, avatar_behavior motion, drag origin |
| `ribbon-reply` | `#moa-ribbon-reply` | `ribbonReplyView` | streamed assistant text, status glyph |
| `rail` | `.moa-rail` | inline row inside a ribbon | copy button, revealed on tap |
| `menu` | `#moa-menu` | popup window | hold menu, ≤ 4 rows |

Nothing else exists in the overlay. No settings entry point, no mode selector,
no history list, no approval UI, no page-identity strip, no log. Those live in
the full Android app and the browser side panel.

The text composer (`#agee-input` / `panelView`) is **not** part of the unit. It
opens on the existing gesture (voice-first triple-click / Android `showPanel`)
and continues to anchor above the companion using
`MoaOrbOverlayGeometry.anchoredSurface`. When the composer is open the ribbons
hide (opacity 0) so there is only ever one text surface.

Landed 2026-07-28 in the browser: the composer is now the input row alone. The
page-identity strip, the Copy/History buttons, the inline history snapshot, the
language chip and the legacy voice strip are deleted, not hidden. **No voice
gesture opens the composer** — a spoken turn reads in the ribbons, which is what
stops the panel covering the page while Ag talks. Cue cards no longer render
ordinary turn text; a card is materialized only when a turn grows a control the
ribbons cannot hold (approval row, dictation copy, microphone recovery).

## 2.1 Ribbon internals

```text
┌ ribbon (fixed 320 × 28, no background in ambient) ───────────────┐
│ ▒fade▒ …the flight to Addis Ababa in early Novem▊  [⧉]           │
│  16px   ← inner line, translateX(-overflow)      ↑caret  ↑rail   │
└──────────────────────────────────────────────────────────────────┘
```

- **viewport** — `overflow: hidden`, fixed width and height. Never resized by
  content. This is the whole anti-reflow guarantee.
- **line** — one `white-space: nowrap` run. Left-aligned in the viewport.
  Transformed by `translateX(min(0, viewportInnerWidth - lineWidth))`.
  While the text fits, `translateX` is 0 and the text is still. Once it
  overflows, the line slides left so the newest character stays pinned at the
  right inner edge. Never animate width; only `transform`.
- **fade** — a 16px left mask (`mask-image: linear-gradient(to right,
  transparent 0, black 16px)`) applied only while `translateX < 0`.
- **caret** — 1.5 × 14px bar at the tail, `--moa-accent`, visible only while
  that ribbon is receiving deltas. Blinks at 1.06s.
- **rail** — appears at the right, inside the viewport, only in `engaged` state.
  One button: copy. 24 × 24 hit target, 20 × 20 glyph.
- **speaker glyph** — 2px round dot at the left, outside the viewport,
  `--moa-you` for the top ribbon and `--moa-agent` for the bottom. It is the
  only always-visible ribbon chrome; it is how you tell the two apart with no
  labels.

# 3. Geometry

All values are logical px (browser) / dp (Android). One scalar drives the
companion: the existing `ageeMascotScale` (browser, scroll-to-resize) and
`ORB_WINDOW_DP` (Android). Ribbons do **not** scale with it.

| Token | Value | Note |
|---|---|---|
| `--moa-ribbon-w` | `clamp(232px, 44vw, 340px)` | browser |
| ribbon width (Android) | `min(screenWidth - 2×16, 340dp)` | |
| `--moa-ribbon-h` | `28px` | fixed, both surfaces |
| `--moa-ribbon-pad-x` | `10px` | inner |
| `--moa-gap` | `8px` | companion ↔ ribbon |
| `--moa-dot-size` | `5px` | speaker dot |
| `--moa-dot-offset` | `10px` | left of the ribbon box |
| companion box | `2.8em` of `--agee-mascot-font` (browser, unchanged) / `ORB_WINDOW_DP` (Android, unchanged) | |
| unit width | `--moa-ribbon-w` | the companion is narrower and centres in it |
| unit height | `28 + 8 + companion + 8 + 28` | ≈ 128px at default companion size |
| `--moa-edge-margin` | `16px` | minimum distance from any viewport/screen edge |
| menu width | `176px` | |
| menu row height | `36px` | |

## 3.1 Placement and flipping

The unit's anchor point is the **companion centre**. Stored position is the
companion's own x/y, exactly as today (`ageeLauncherPos` / `orbParams.x/y`), so
existing persistence needs no migration.

**The companion's vertical centre line is the seam.** Revised 2026-07-29, and
normative for every surface:

- the **you-box** hangs off that line to the **right**: its LEFT edge sits on
  `companionCenterX`;
- the **reply-box** hangs off the same line to the **left**: its RIGHT edge sits
  on `companionCenterX`.

The pair therefore pivots on the companion instead of reading as two bars
stacked on one another, and which side a line is on tells you who is speaking
before you read a word. Near a viewport edge the preferred side does not fit; a
box then **mirrors to the other side of the same line** rather than sliding off
it. Only a viewport narrower than one box breaks the seam, and there staying on
screen wins. Both lines stay left-anchored *inside* their own box so the sliding
window keeps ownership of the horizontal offset (§4).

**The words are anchored to the seam edge, not the box.** Revised again the
same day, after the first build shipped and looked wrong: a box whose right
edge sits on the line still renders its text left-anchored inside 340px, so a
short line ends up a third of a screen away from the companion and the unit
reads as floating. Each box therefore reports which of its edges landed on the
line (`youSeam`/`replySeam`), and the text inside is anchored to that edge — the
words always sit against the companion, from whichever side. Anchoring applies
only while the line fits; once it is clipped the line fills the box and the
sliding window owns the offset. The speaker dot hangs off the opposite edge, so
nothing is ever drawn between the words and the mark.

Ribbons are laid out relative to the companion and then clamped:

1. Compute `youLeft = companionCenterX` and `replyLeft = companionCenterX -
   ribbonW`, each mirrored across the seam if it does not fit, then clamped to
   `[edgeMargin, viewportW - ribbonW - edgeMargin]`.
2. If `companionTop - gap - ribbonH < edgeMargin + safeAreaTop`, the top ribbon
   **flips** below the companion and the reply ribbon flips below it — both
   ribbons stay in their you-then-reply reading order, they just move as a pair.
   The companion never moves to make room (this reverses the current Android
   `anchoredSurface` rule, which moves the orb; the ribbons are small enough to
   flip instead, and moving the user's companion under them is surprising).
3. Same test at the bottom edge: both ribbons flip above.
4. The flipped state is sticky for the turn; it re-evaluates only on drag end,
   viewport resize, or rotation, never mid-stream.

## 3.2 Non-negotiable layout invariants

- A streaming delta must not change any element's width, height, or position.
  The only property that may animate during streaming is the line's
  `transform: translateX()`.
- Ribbon height is constant across all states, including `engaged`. Solidifying
  adds a background and a border **inside** the existing box (the border is
  drawn with `box-shadow: inset 0 0 0 1px`, not `border`, so it costs no layout).
- The unit never becomes taller than `edgeMargin*2` less than the viewport.
  If the companion is scaled up enough to break that, the ribbons clamp the
  companion's rendered scale, not the other way round.

# 4. Sliding-window text rule

Each ribbon owns a `buffer` (the full text of the current turn's stream) and
renders a `window` of it. Both bounds are load-bearing; implement both.

```text
WINDOW_CHARS      = 140     // hard character cap on the rendered node
BUFFER_MAX_CHARS  = 8000    // per-turn retained text, used by copy
SLIDE_MS          = 90      // translateX transition
```

**On each delta:**

1. `buffer += delta`; if `buffer.length > BUFFER_MAX_CHARS`, drop from the
   front in whole grapheme clusters and set `truncated = true`.
2. `window = tailGraphemes(buffer, WINDOW_CHARS)` — the last `WINDOW_CHARS`
   grapheme clusters, never a split cluster. Ethiopic and CJK count as one
   cluster per rendered glyph; use `Intl.Segmenter('…', {granularity:'grapheme'})`
   in the browser and `BreakIterator.getCharacterInstance()` on Android.
3. Set the line's text to `window`. Do **not** prepend an ellipsis; the left
   fade mask *is* the truncation indicator.
4. Measure `lineWidth` (browser: `scrollWidth`; Android: `Layout.getLineWidth(0)`).
   Set `translateX = Math.min(0, viewportInnerWidth - lineWidth)`.
5. Transition `translateX` over `SLIDE_MS` linear. Coalesce to one write per
   animation frame — reuse `MoaFrameCoalescer` on Android; use a
   `requestAnimationFrame` guard in the browser.

**Rules:**

- `WINDOW_CHARS = 140` is a safety cap on DOM/TextView cost, not the visual
  window. The visual window is geometric (step 4) and adapts to font metrics,
  script, and ribbon width. 140 clusters comfortably exceeds what 340px of
  13px text can show in any supported script, so the geometric rule always
  governs what is visible.
- The window is a **tail** window. The user always sees the newest text. There
  is no auto-scroll-back, no pause-on-hover scrollback, no "jump to end".
- A partial transcript that is later replaced by a final transcript replaces the
  whole buffer (this is what `mergeLiveVoiceTranscript` already produces); the
  slide re-runs once, still over `SLIDE_MS`.
- Copy always copies the **full buffer**, never the window. If `truncated` is
  true the copy is prefixed with nothing and the rail's toast reads
  "Copied (from the last 8,000 characters)".
- When a turn ends, the buffer is frozen and remains copyable through the
  ribbon's linger window (§5). The next turn's first delta clears it.

## 4.1 Reading pace — the line must always be moving

Normative for every surface. A reply that arrives whole (a text-only turn, a
provider that does not stream, a burst of buffered deltas) must NOT appear as
one block. Each ribbon keeps two strings:

```text
target   // everything the ribbon has been given
buffer   // the prefix it has actually shown
```

`buffer` advances toward `target` on a timer, counted in grapheme clusters, not
code units. Two reasons, both load-bearing: a syllabic script carries far more
meaning per glyph than Latin, so a code-unit rate that reads well in English
flashes past in Amharic; and slicing a string by code-unit index can cut a
combining sequence or a surrogate pair in half and paint a broken glyph for a
frame.

```text
REVEAL_CPS        = 26      // GRAPHEME CLUSTERS per second, ordinary pace
REVEAL_TICK_MS    = 40      // timer granularity
REVEAL_CATCHUP_MS = 2500    // whatever the backlog, it is caught up within this
step = max(1, round(max(REVEAL_CPS, backlog / (REVEAL_CATCHUP_MS/1000)) * REVEAL_TICK_MS/1000))
```

Rules:

- **Pacing is presentation only.** `target` is the whole reply from the moment
  it lands. Copy, the copy-variant rail and the opened view all read `target`,
  never `buffer`. The overlay must never imply Ag said less than it did.
- **Only the reply line is paced.** The user line renders its transcript
  immediately: partial hypotheses rewrite themselves, and pacing would fight the
  correction.
- **Touching a box finishes the reveal at once.** Opening it is the "all of it,
  now" gesture.
- **A turn is not visually over until the reveal is.** If `turn_done` arrives
  mid-reveal, the caret stays and the linger timer is parked until the last
  character is on screen. A reply must never be wiped a frame after it appears.
- This is what makes a spoken reply and a silent one look the same: with voice
  off, the text still arrives at a pace a person can read.

## 4.2 Text mode is the same buffer

Normative for every surface. There is no separate composer for ordinary typing.
A single click/tap on the companion puts a caret in the **you-line**, which
becomes an editable single-line buffer running the identical sliding window the
transcript uses:

- one buffer, one place to look for what you are about to say;
- Enter submits it as an ordinary turn; Escape ends text mode and clears;
- a real turn taking the line (a capture opening, a transcript arriving, a
  presentation adopting user text) ends text mode — one owner at a time;
- a caret in the buffer is an engaged state and is exempt from the latch
  timeout: a timer must never take the line out from under someone mid-sentence.
  Clicking away or Escape releases it.

The panel (browser `#agee-panel` / Android `panelView`) survives only as the
approval and notes surface. No gesture that starts voice or text may raise it.

## 4.3 Copy is a disposition, not just a clipboard write

Copy pressed while a capture is live **finalizes what has been said so far and
does not send it**: the capture stops, no turn is created, and the clipboard
receives the settled transcript. This is what makes the overlay usable for
dictating into another app. After a turn has ended, Copy is an immediate local
clipboard action as before.

## 4.4 An opened box shows at most five lines

Opening a box (tap/click) shows the whole of `target`, wrapped, capped at five
line boxes and scrollable past that. The same cap applies to both boxes. An
opened box is still sitting on the user's page; five lines is as much of it as
the overlay may ever cover.

# 5. Opacity states

Four states per element. The unit as a whole holds the state; the elements
render it. Transitions use `--moa-ease-out` / `--moa-dur-solidify` (§8).

| State | Trigger | Companion | Ribbons | Ribbon plate | Pointer events |
|---|---|---|---|---|---|
| `dormant` | no text, no pointer within `--moa-proximity`, ≥ linger since last turn | opacity `0.34` browser / `0.18` Android | opacity `0`, `visibility: hidden` after the fade | none | companion only |
| `ambient` | text present and streaming, or within linger | opacity `0.92` | opacity `1`, text at `--moa-ink-ambient` with halo | **none** — glyphs float directly on the page | companion only |
| `engaged` | pointer/finger down on any element, or `latched` from a tap | opacity `1` | opacity `1`, text at `--moa-ink` | full: fill + inset hairline + blur + shadow | whole unit |
| `dragging` | pointer down + moved past slop | opacity `1`, scale `1.04` | opacity `1`, plate at 70% of engaged fill | reduced | whole unit, capture |

Additional rules:

- **`dormant` is the default and the resting state.** Everything returns here.
- `ambient` never paints a filled rectangle. Legibility comes from the halo:
  a dual text-shadow (`--moa-halo`) plus a per-glyph-run scrim
  (`background: --moa-scrim` on the inline `<span>` of the line, with
  `padding: 1px 4px; border-radius: 4px; box-decoration-break: clone`). The
  scrim hugs the text, so an empty ribbon paints nothing at all.
- **Proximity pre-lights, it does not solidify.** Within `--moa-proximity`
  (72px) of the unit, a pointer raises `dormant` companion opacity to `0.7`
  over `--moa-dur-slow`. Touch surfaces have no hover; on Android this state
  does not exist and `dormant` → `engaged` is the only path.
- `latched` (from a ribbon tap) holds `engaged` for `--moa-dur-latch` (6000ms),
  re-armed by any pointer movement over the unit, and released early by a
  pointer-down outside the unit.
- Linger after a turn ends: `--moa-linger-you` (4500ms) for the top ribbon,
  `--moa-linger-reply` (9000ms) for the bottom. A ribbon that is `latched`,
  `engaged`, or has an open menu does not start its linger timer until it
  returns to `ambient`.
- Reduced motion / reduced transparency: with
  `prefers-reduced-transparency` (or Android `isHighTextContrastEnabled`),
  `ambient` uses the `engaged` plate at 0.86 opacity instead of the halo. This
  is the only sanctioned occluding state and it is user-requested.

# 6. Drag: the unit moves as one

- **Every element is a drag handle.** Companion, both ribbons, and the rail's
  empty space all start a drag. There is no dedicated grab bar.
- Drag begins after the pointer moves past the platform slop
  (`ViewConfiguration.getScaledTouchSlop()` on Android, `6px` in the browser)
  from the down point. Below slop, the gesture is still a tap/hold candidate.
- Dragging translates the **companion anchor**. Both ribbons are repositioned
  from that anchor every frame by the §3.1 rule. Their offsets from the
  companion are constant during a drag; only the edge clamp and the flip test
  may change them, and the flip test is deferred to drag end (§3.1.4).
- A drag that starts on a ribbon **cancels** that ribbon's pending tap and hold,
  and cancels a pending push-to-talk if it started on the companion — this is
  the existing "large movement escapes into drag" rule from the voice-first
  gesture contract and is not changed.
- Android keeps `MoaOverlayGroupDragListener` as the implementation; it already
  drags `orbView` and republishes anchored surfaces through a callback. The
  ribbons become two more surfaces on that callback. Frames stay coalesced
  through `MoaFrameCoalescer`.
- Browser keeps `startLauncherDrag`; the listener is attached to `#moa-unit`
  rather than `#agee-launcher`, and the persisted key stays `ageeLauncherPos`.
- On drag end the unit settles with `--moa-ease-settle` over
  `--moa-dur-settle`. It does **not** snap to an edge — the user's placement is
  respected exactly, clamped only by `--moa-edge-margin`.
- Android's existing drag-to-remove target (bottom-centre) is unchanged and
  still applies to the whole unit.

# 7. Gesture table

Slop, hold threshold, and multi-tap window are shared across the three
elements so the unit feels like one object.

```text
TAP_SLOP        = 6px browser / ViewConfiguration touch slop on Android
HOLD_MS         = 340
MULTITAP_MS     = 260   (gap between taps to count as a sequence)
```

| Gesture | Companion | Ribbon (either) |
|---|---|---|
| **tap** (down/up < HOLD_MS, < slop) | Existing voice-first contract: toggle current-thread capture. Flag off: open composer. **Unchanged.** | Solidify + latch `engaged`, reveal the copy rail. A second tap on the rail's copy button copies; a second tap elsewhere on the ribbon releases the latch. |
| **hold** (down ≥ HOLD_MS, < slop) | Existing: push-to-talk. Release commits. **Unchanged.** | Open the ribbon menu (§7.1). Ribbon enters `engaged` at HOLD_MS with a 4px lift and a haptic tick on Android. |
| **double-tap** | Existing: fresh-thread capture toggle. **Unchanged.** | Open **History** (§7.2). The ribbon flashes `--moa-accent` at 12% for 180ms as the acknowledgement. |
| **triple-tap** | Existing: cancel capture, open composer. **Unchanged.** | — (a third tap is absorbed; no action) |
| **drag** (past slop) | Move the unit. | Move the unit. |
| **scroll / wheel** | Existing: resize the companion. **Unchanged.** | Ignored; the page scrolls normally. |

The companion's gesture map is deliberately untouched. Users have muscle memory
for it, it is specified in `ARCHITECTURE.md`, and re-specifying it here would
create two competing contracts.

## 7.1 Hold menu

Max 4 rows, no submenus, no scrolling. Opens anchored to the held ribbon's
nearest horizontal edge, flipping to stay inside `--moa-edge-margin`. Dismissed
by any outside press, Escape, or 5s of no pointer.

**Top ribbon (you):**

| Row | Effect |
|---|---|
| Copy | Full buffer to clipboard. |
| Copy as note | Full buffer to clipboard, prefixed with the turn timestamp. |
| Open history | Same as double-tap (§7.2). |
| Hide overlay | Existing hide path (Android `stopSelf`, browser `dismissOverlayUi`). |

**Bottom ribbon (reply):**

| Row | Effect |
|---|---|
| Copy | Full buffer to clipboard. |
| Replay | Replay this turn's assistant audio, if retained. Disabled and dimmed when it is not. |
| Stop speaking | Halt playback. Shown only while speaking; replaces Replay. |
| Open history | Same as double-tap (§7.2). |

Menu rows are inert proposals in the UI sense: none of them takes a model
action, launches a run, or changes a setting. Settings remain agent-opened only.

## 7.2 History is a different surface

Double-tap does **not** turn the ribbon into a scrollback. It hands off:

- **Browser:** open the extension side panel on its History view
  (`chrome.sidePanel.open`), hydrated from
  `GET /v1/sessions/:id/messages` — the existing canonical projection. The
  overlay stays exactly as it was.
- **Android:** launch `MainActivity` on the history screen with
  `FLAG_ACTIVITY_NEW_TASK`, same projection. The overlay stays alive behind it.

This keeps the "the overlay is not a chat" principle intact while giving the
user the fast path they asked for. **Judgment call — see §10.**

# 8. Motion and timing

| Token | Value | Used for |
|---|---|---|
| `--moa-ease-out` | `cubic-bezier(0.22, 1, 0.36, 1)` | appear, solidify |
| `--moa-ease-in` | `cubic-bezier(0.55, 0, 1, 0.45)` | dismiss, fade to dormant |
| `--moa-ease-settle` | `cubic-bezier(0.16, 1.02, 0.3, 1)` | drag release, menu open |
| `--moa-ease-linear` | `linear` | ribbon slide only |
| `--moa-dur-fast` | `120ms` | rail reveal, caret |
| `--moa-dur-solidify` | `140ms` | ambient → engaged |
| `--moa-dur-soften` | `260ms` | engaged → ambient |
| `--moa-dur-slow` | `420ms` | ambient → dormant, proximity pre-light |
| `--moa-dur-slide` | `90ms` | ribbon `translateX` |
| `--moa-dur-settle` | `320ms` | drag release |
| `--moa-dur-menu` | `160ms` | menu in; out is `120ms` with `--moa-ease-in` |
| `--moa-dur-latch` | `6000ms` | tap-latched `engaged` hold |
| `--moa-linger-you` | `4500ms` | top ribbon linger after turn end |
| `--moa-linger-reply` | `9000ms` | bottom ribbon linger after turn end |

Named animations:

- `moa-ribbon-in` — `opacity 0→1`, `translateY(4px)→0`, `filter: blur(3px)→0`,
  `--moa-dur-solidify`, `--moa-ease-out`.
- `moa-ribbon-out` — reverse, `--moa-dur-slow`, `--moa-ease-in`.
- `moa-caret` — `opacity 1→0.15→1`, `1060ms`, `steps` feel via
  `cubic-bezier(0.4,0,0.6,1)`, infinite.
- `moa-listen` — while capture is open, the top ribbon's speaker dot scales
  `1→1.35→1` over `1200ms` and the companion keeps its existing
  avatar_behavior motion. **The companion's own animation set is unchanged.**
- `moa-flash` — double-tap acknowledgement: an inset `--moa-accent` at 12%
  fading out over `180ms`.
- `moa-copied` — the rail glyph swaps to a check and the ribbon's inset
  hairline pulses `--moa-ok` once over `520ms`. No toast on Android beyond the
  system copy confirmation; browser shows a 12px caption under the ribbon for
  `1400ms`, positioned absolutely so it cannot reflow the unit.

`prefers-reduced-motion`: all durations collapse to `1ms` except
`--moa-dur-slide` which becomes `0ms` (the line jumps to its new offset). No
looping animations run; the caret is solid, the listen pulse is a static
1.2× dot.

# 9. Tokens

Ship these as CSS custom properties on `#moa-unit` (browser) and as constants in
a new `MoaRibbonTokens.java` next to `MoaColors` (Android). Android values are
`0xAARRGGBB`.

## 9.1 Colour

The dark set continues the existing warm-ember identity (`--agee-amber`,
`--agee-gold`, `MoaColors`). The light set is new; it is required because the
ambient state has no plate, so glyphs sit on whatever the page or app behind is.

| Token | Dark | Light | Role |
|---|---|---|---|
| `--moa-ink` | `#F4F4F6` | `#141519` | engaged text |
| `--moa-ink-ambient` | `rgba(244,244,246,0.88)` | `rgba(20,21,25,0.90)` | ambient text |
| `--moa-muted` | `#9B9BA4` | `#6B6C76` | menu secondary, disabled |
| `--moa-accent` | `#FFD76A` | `#B87400` | caret, flash, focus ring |
| `--moa-you` | `#7C5CFF` | `#5B3FE0` | top speaker dot |
| `--moa-agent` | `#F5A623` | `#C06B00` | bottom speaker dot |
| `--moa-ok` | `#35C759` | `#1F8F3D` | copied pulse |
| `--moa-warn` | `#FF8A3D` | `#C24A00` | tts_error, incomplete turn |
| `--moa-plate` | `rgba(14,15,18,0.72)` | `rgba(252,252,253,0.76)` | engaged fill |
| `--moa-plate-drag` | `rgba(14,15,18,0.50)` | `rgba(252,252,253,0.54)` | dragging fill |
| `--moa-hairline` | `rgba(255,255,255,0.14)` | `rgba(0,0,0,0.10)` | inset border |
| `--moa-scrim` | `rgba(9,10,12,0.42)` | `rgba(255,255,255,0.52)` | per-glyph ambient scrim |
| `--moa-halo` | `0 1px 2px rgba(0,0,0,0.72), 0 0 8px rgba(0,0,0,0.45)` | `0 1px 2px rgba(255,255,255,0.88), 0 0 8px rgba(255,255,255,0.62)` | ambient text-shadow |
| `--moa-shadow` | `0 8px 28px rgba(0,0,0,0.46), 0 1px 2px rgba(0,0,0,0.34)` | `0 8px 28px rgba(16,18,24,0.14), 0 1px 2px rgba(16,18,24,0.10)` | engaged drop shadow |
| `--moa-menu-bg` | `rgba(18,19,23,0.86)` | `rgba(252,252,253,0.88)` | menu fill |
| `--moa-menu-row-hover` | `rgba(255,255,255,0.08)` | `rgba(0,0,0,0.05)` | |

Theme selection: the browser follows `prefers-color-scheme` **and** a computed
estimate of the page's own background luminance behind the unit, sampled once
per placement change; when the page is light and the OS is dark, the page wins,
because the glyphs sit on the page. Android follows `Configuration.uiMode` only
(there is nothing behind the overlay it can sample). See `parity.md`.

## 9.2 Type

| Token | Value |
|---|---|
| `--moa-font` | `ui-sans-serif, -apple-system, "Segoe UI", Roboto, "Noto Sans Ethiopic", sans-serif` |
| `--moa-size-ribbon` | `13px` / line-height `18px` / weight `450` / letter-spacing `0.005em` |
| `--moa-size-menu` | `13px` / `18px` / `500` / `0` |
| `--moa-size-caption` | `11px` / `14px` / `500` / `0.01em` |
| `--moa-size-label` | `10px` / `12px` / `600` / `0.08em` uppercase (used nowhere in the default layout; reserved) |
| `--moa-tabular` | `font-variant-numeric: tabular-nums` on all ribbon text, so streaming digits do not jitter the slide |

Android: `13sp`, `18sp` line spacing, `Typeface` medium-ish via
`setTypeface(null, Typeface.NORMAL)` with `setLetterSpacing(0.005f)`. Ribbons do
**not** honour system font scaling above 1.3× — beyond that, the ribbon height
grows to `32dp` once and then clamps, because an unbounded ribbon breaks the
no-reflow invariant.

## 9.3 Radius, blur, elevation

| Token | Value |
|---|---|
| `--moa-radius-ribbon` | `9px` |
| `--moa-radius-scrim` | `4px` |
| `--moa-radius-menu` | `12px` |
| `--moa-radius-rail` | `6px` |
| `--moa-blur` | `18px` (`backdrop-filter: blur(18px) saturate(1.3)`) |
| `--moa-blur-menu` | `24px` |
| `--moa-hairline-w` | `1px`, drawn as `box-shadow: inset 0 0 0 1px var(--moa-hairline)` |
| Android blur | `RenderEffect.createBlurEffect` on API 31+; below 31, `--moa-plate` alpha rises to `0.90` and no blur is applied |

## 9.4 Accessibility

- Ribbon text is `aria-live="polite"` on the reply ribbon and
  `aria-live="polite" aria-atomic="false"` on the you ribbon. Deltas must not
  re-announce the whole buffer: announce only the appended text.
- Focus ring: `2px solid var(--moa-accent)`, `offset 2px`, on every focusable
  element (companion, both ribbons, rail button, menu rows).
- Every ribbon is `role="button"` with an `aria-label` naming its speaker and
  its gestures, because a screen-reader user cannot discover the hold menu.
- Minimum hit target is 28 × 28 for the ribbon (its full height) and 24 × 24 for
  the rail button; the rail button's hit box is padded to 32 × 28 without
  changing its painted size.
- Contrast: in `ambient`, `--moa-ink-ambient` + `--moa-scrim` must clear 4.5:1
  against both `#FFFFFF` and `#000000` backdrops. The scrim values in §9.1 are
  chosen to satisfy this; changing the scrim requires re-checking both.

# 10. Judgment calls the user should confirm

1. **History opens a different surface, not an in-overlay scrollback.** The
   request was "double click the text box → open all the chat history and scroll
   through it". The stated product principle is that the overlay is not a chat
   and holds no history. Resolution: double-tap opens the browser side panel /
   Android history screen, which already read the canonical session projection.
   The gesture is exactly what was asked for; the surface it opens is a real
   window rather than an expanded overlay. If the intent was specifically that
   history appear *in place*, over the page, this changes.
2. **Two ribbons, not one.** The user described the top stream and then said
   "maybe we have a different stream on the bottom for the response". Specified
   as two permanent ribbons. The alternative — one ribbon that switches speaker —
   is smaller but loses the ability to see what you said while the reply streams.
3. **The companion never moves to make room.** This reverses the current Android
   `anchoredSurface` rule, which pushes the orb down when the card will not fit.
   The ribbons flip instead. Existing `MoaOrbOverlayGeometry` tests will need
   updating for the ribbon path; the composer path keeps the old rule.
4. **Ambient has no plate at all.** Legibility rests on the halo + per-glyph
   scrim. It is the correct answer to "transparent unless I'm pressing", and the
   mock demonstrates it over both light and dark page content. If it reads as
   too faint on real pages, the fallback is raising `--moa-scrim` alpha, not
   adding a full-width plate.
5. **Font scaling clamps at 1.3×.** Larger system fonts would otherwise force
   the ribbon to grow or wrap, breaking the no-reflow invariant. Users at very
   large accessibility font sizes get a 32dp ribbon and no more.
