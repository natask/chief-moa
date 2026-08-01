# Design: Recording Visibility And Control

## 1. Evidence this is grounded in

Read directly from source in this checkout (branch `lane/openspec-close-20260727`,
based on `feat/device-preview-delivery-20260723`), not from docs or specs.

### 1.1 Android — how capture starts today

| Gesture | Handler |
|---|---|
| Single tap on orb (voice-first) | `OverlayService.handleOrbStartTalkLoop` → `startReviewableVoiceDraft()` — `OverlayService.java:2613-2632`, `:3262` |
| Press-and-hold (push-to-talk) | Resolved in `MoaOrbTouchListener.java` (contract comment `:23-42`); mic pre-warmed on press-down `:284-297` |
| Double-click-and-hold (audio note / "record mode") | `OverlayService.startAudioNoteCapture` — `OverlayService.java:2994-3023` |

Hardware start (`AudioRecord.startRecording()`) is
`MoaAudioCaptureController.openAudioRecordLocked` —
`MoaAudioCaptureController.java:238-261`, called from `warmUp()` (`:81-97`)
and `start()` (`:99-133`).

**The one non-fresh-gesture case:** once a voice-first tap enters the
continuous loop, `continuousVoiceLoop = true` is set (`OverlayService.java:3271`,
also `:3165`). After each turn, `showReadyForNextVoiceTurn` (`:3900-3915`)
checks the flag and calls `scheduleContinuousVoiceRestart` (`:1536-1549`),
which re-warms the mic (`beginWarmMic()` → `warmMic.warmUp()`, real
`AudioRecord.startRecording()`) and, 420 ms later
(`CONTINUOUS_VOICE_RESTART_MS`, `:66`), starts a brand-new capture turn with
**no additional tap or hold**. It self-terminates on dismiss
(`OverlayService.java:2897`, `:3768`) or an empty-turn/error path
(`:3675-3676`), and only exists because the user made one earlier explicit tap
to enter the loop — but from the user's point of view, once they have finished
speaking and set the phone down, the mic can come back on by itself. This is
the closest thing in the codebase to what the 07-18 turns describe, and it is
live code, not a proposal.

No wake-word or screen-on trigger exists anywhere in `android_app`.

### 1.2 Browser extension — how capture starts today

- `getUserMedia`/`MediaRecorder` live in the offscreen document
  (`offscreen.js:98-116` voice, `:272-299` combined screen+mic), so the OS
  permission is granted to `chrome-extension://…`, not the page.
- Click on the overlay voice button (`content.js:432-439`) or the
  single/double/triple-tap chain on the launcher
  (`resolveVoiceFirstTapChain`, `content.js:901-919`) starts it; pointerdown
  pre-warms the mic before the gesture resolves (`content.js:439/453/612`).
- `startOffscreenVoiceCapture` (`background.js:2389-2403`) is the actual
  trigger to the offscreen document's `getUserMedia` call.
- No wake-word, no idle auto-start, no browser-side equivalent of
  `continuousVoiceLoop` was found in `content.js`/`background.js`/`offscreen.js`.
- Per `ARCHITECTURE.md:945-951`, capture is one extension-wide lifecycle owned
  by the background worker/offscreen recorder, not per-tab — every tab is a
  passive view of the same state (`background.js:2922` broadcasts
  `voiceSessionEvent`; `content.js:4440`, `:3527`, `:4465` hydrate from it). So
  **capture continues across tab switches**, and a tab whose overlay was never
  injected shows no indicator at all for capture that is, in fact, still
  running.

### 1.3 macOS — superseded by the native companion

This original finding described the former browser bridge. The active native
contract is now owned by `macos-clicky-parity-surface`: double-tap Left Command
opens `Ag.app`, toggles its one assistant capture, and never raises Chrome or
attaches page context. The native panel owns its persistent listening boundary,
visual pulse, and haptic feedback. Browser dictation remains a separate explicit
browser surface.

### 1.4 Existing visible indicators (before this change)

- Android: `OrbView.setListening(boolean)` (`OrbView.java:129-132`) drives a
  steady violet rim (`LISTENING_RIM`, `:45`, rendered `:239-250`,
  `:292-298`), driven from `OverlayService.updateMicState()`
  (`OverlayService.java:3969-3973`). A **separate** record-mode indicator,
  `OrbView.setRecordingNote(true)` (`OverlayService.java:3023`/`:3059`/`:3100`),
  tints the mark steady red (`RECORDING_TINT`, `OrbView.java:41`, `:223-224`),
  deliberately distinct from a live voice turn (comment `OrbView.java:16-23`).
- Browser: `#agee-voice.listening` (`overlay.css:627-632`, gold tint,
  toggled `content.js:2550-2554`) and `#agee-record.recording`
  (`overlay.css:634-638`, steady red) plus a mascot-wide red hue-rotate while
  an audio note is capturing (`overlay.css:640-644`). **No
  `chrome.action.setBadgeText`/`setIcon` call exists anywhere in
  `background.js`** — confirmed by grep across the file; the only
  `chrome.action` use is `onClicked` (`:4678`) to open the panel. The
  indicator is exclusively an in-page DOM element.
- Dismissal already stops capture on Android:
  `dismissOverlayUi(boolean)` (`OverlayService.java:2891-2917`) calls
  `cancelAudioNoteCapture()`, `discardWarmMic()`, `cancelStreamingVoice()`,
  and clears `continuousVoiceLoop = false` before removing the overlay
  surfaces. So today, hiding the overlay already cannot leave capture running
  invisibly — the risk in the 07-18 case is not "hide leaves it running," it's
  "the indicator that says it's running is too easy to miss while it is
  running."

## 2. The tension with the overlay redesign, resolved

The sibling `design-overlay` lane's contract
(`reference/design/overlay-2026-07/spec.md` in worktree `.wt/design-overlay`,
read read-only for this proposal, not modified) defines four opacity states
for the ribbon unit — `dormant`, `ambient`, `engaged`, `dragging` (spec §5).
In `dormant` (the default, resting state — "everything returns here"), the
ribbons render at `opacity: 0` with `visibility: hidden` after the fade (spec
§5 table). The companion itself never goes fully invisible in that design —
`dormant` companion opacity is `0.34` (browser) / `0.18` (Android) — but it is
faint, and nothing about the ribbon design ties recording state to the
companion at all. The design's only mic-related touch is `moa-listen` (spec
§8): while capture is open, the top ribbon's *speaker dot* — which lives
inside the ribbon, and is therefore fully hidden in `dormant` — scales up.
That is exactly the gap: **the one capture-adjacent animation in the new
design is attached to an element that disappears in the state the unit
spends most of its time in.**

**Resolution — the recording-active state is a fifth, orthogonal state that
overrides ribbon-visibility rules, attached to the companion:**

1. Recording-active is **not** one of `dormant`/`ambient`/`engaged`/`dragging`.
   It composes with all four: whichever ribbon opacity state is current still
   governs the ribbons, but the companion additionally renders a steady,
   distinct visual (see §3) whenever the microphone hardware is open, with no
   minimum-opacity floor lower than `0.7` for that specific visual — i.e. even
   in `dormant`, the recording glyph on the companion cannot fall to the
   companion's own dormant opacity (`0.34`/`0.18`). This is the one exception
   to "dormant is the default, resting state" the ribbon spec anticipates
   under "reduced transparency" (spec §5, "the only sanctioned occluding
   state"); recording-active is the second sanctioned exception, and it is
   user-safety-driven rather than accessibility-driven.
2. It is keyed to **microphone hardware state**, not turn/session state — it
   must be true for exactly as long as `AudioRecord.startRecording()` /
   `getUserMedia()`'s returned stream is open, including the silent
   pre-roll/warm window and including every iteration of
   `continuousVoiceLoop`'s re-arm (§1.1). It must go false the instant the
   stream is stopped, not when a turn UI element is dismissed — those are
   already coupled today (§1.4) and this change must not decouple them.
3. It does not add a background plate, blur, or any of the `engaged`-state
   chrome to the ribbons. The ribbons keep their existing behavior exactly.
   Only the companion gets the addition, and only a color/glyph change, not a
   size or position change — this preserves "the companion's own animation
   set is unchanged" (ribbon spec §8) as a boundary this proposal does not
   cross for the *avatar_behavior* motion layer, while still asserting a
   recording-specific visual on top of it.
4. This does not reopen or relitigate the ribbon redesign. It is one addition
   layered on a contract this proposal treats as fixed.

## 3. What the indicator actually is

Reusing existing, already-shipped visual language rather than inventing a new
one:

- **Android:** extend `OrbView`'s existing rim-tint mechanism
  (`OrbView.java:41-45`, `:223-250`) with a state that takes priority over
  `LISTENING_RIM` and `RECORDING_TINT` when both would otherwise apply, and
  that is exempted from whatever opacity floor the ribbon-redesign work
  applies to the companion in `dormant`. Concretely: the mic-hardware-open
  state (§2.2) drives a rim that never dims below the `0.7` floor even if the
  rest of the companion is at `dormant` opacity — this is a floor on top of
  existing rendering, not a new drawable.
- **Browser, in-page:** extend the existing `.listening`/`.recording` classes
  (`overlay.css:627-644`) with the same `0.7`-floor override so they remain
  visible through `dormant`, keyed to the same mic-hardware-open signal
  `content.js` already tracks for `.listening`/`.recording` (§1.4), not to
  ribbon-visibility state.
- **Browser, toolbar (new):** add a `chrome.action.setBadgeText`/`setBadgeBackgroundColor`
  call, set when the offscreen recorder's mic-open signal is true and cleared
  when it is false. This is the fallback for the case the 07-18 incident
  structurally cannot rule out on the in-page indicator alone: a tab where the
  overlay was never injected, was scrolled past, or the browser window itself
  is not focused. No such call exists today (§1.4) — this is new.
- The later native Mac companion owns its own boundary/pulse/haptic indicator;
  this browser visibility change remains scoped to browser dictation.

## 4. Immediate stop

Already effectively present and must be preserved, not rebuilt: a tap on the
companion during an active voice-first turn toggles capture per the existing,
unchanged gesture contract (ribbon spec §7 table: "tap … toggle current-thread
capture … Unchanged"), and `dismissOverlayUi` already tears capture down
first (§1.4). This proposal's requirement is narrower than "add a stop
control" — it is "the recording-active visual itself must be the same hit
target as the existing stop gesture, at the existing minimum 28×28 hit size,
regardless of which opacity state the companion is currently rendering
at" — i.e. don't let a future implementation shrink or hide the tappable area
under a faint `dormant` companion while claiming the indicator itself stays
visible via the §2 floor.

## 5. Review and delete of the just-ended capture

No client today provides a way to see or delete a specific capture after the
fact. Confirmed by reading `gateway/lib/capture-block-handlers.js:1-60`:
`routeCaptureBlocks` only branches on `request.method !== "GET"` — list,
search, and detail are the entire surface (`/v1/capture-blocks`,
`/v1/capture-blocks/search`, `/v1/capture-blocks/:id`, all GET). There is no
`DELETE` handler anywhere in that file or wired to it in `server.js:616`.
`deleteVoiceTurnPcm` (`server.js:387`, `:9205`) exists but is only called from
the incognito auto-wipe path in `recordStreamingVoiceTurn`
(`gateway/lib/*` — incognito branch), never from a user-facing route.
`reference/openspec/changes/voice-capture-notebook-ime/tasks.md` section 1.4
("Add token-protected create/list/detail/retry/revision/delete-or-tombstone
routes") is unchecked `[ ]` and section 2 (Android notebook UI) is unchecked
`[ ]` — both still open, neither shipped.

This proposal adds the narrowest slice that closes the privacy gap without
absorbing that change's full scope:

- `DELETE /v1/capture-blocks/:id`, token-protected, scoped to the owning
  session, **tombstone semantics**: the block stops appearing in
  list/search/detail reads and any pending routing proposal
  (`file_only`/`unclassified`, per `ARCHITECTURE.md:89-94`) is cancelled, but
  the underlying audio bytes and record are not immediately purged — they
  follow whatever retention window/backup cadence already governs
  `capture-blocks` storage today, so this does not conflict with, or need to
  change, the existing `recovery/` reconciliation path. A hard-purge job is
  explicitly out of scope for this proposal.
- One entry point per surface: from the recording-active companion state
  (§3), once capture stops, the next tap surfaces exactly one thing — "review
  what was just captured" — showing the literal transcript (if any) and a
  Delete action that calls the route above. This is not the notebook/library
  UI from `voice-capture-notebook-ime` section 2; it is scoped to the single
  most-recent capture block for the current session, reachable in at most one
  tap from the indicator. Browsing older captures remains that other change's
  scope.
- This does not change what "review" means for any other entry point (e.g.
  History per the ribbon redesign's §7.5) — those keep reading the same
  `GET /v1/sessions/:id/messages` projection they already use.

## 6. Explicitly not this change's scope

- Rebinding or adding gestures. Every existing gesture (tap/hold/double/triple)
  keeps its current meaning.
- The Android notebook UI, writing-skill copy variants, or the IME
  (`voice-capture-notebook-ime` sections 2-4) — unrelated to this privacy fix
  beyond the one delete route in §5.
- Retroactively deleting, redacting, or flagging any recording that already
  exists, including the 07-18 turns. That is a distinct, higher-stakes
  decision (whose data is it — the other family members were not consenting
  parties either — and what recovery/legal-hold obligations apply) that
  deserves its own explicit proposal, not a side effect of a UI change.
- Any change to local Android `TextToSpeech` — none is proposed; hosted TTS
  only remains the rule.
- Additional macOS indicator work beyond the native companion boundary and
  haptics; that surface is specified by `macos-clicky-parity-surface` (§1.3).
