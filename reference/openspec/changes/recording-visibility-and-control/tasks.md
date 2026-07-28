# Tasks

Every implementation unit has one observable acceptance check. Nothing in this
change is implemented yet; see `proposal.md` and `design.md` for the grounding
evidence and the scope boundary against `voice-capture-notebook-ime`.

## 1. Gateway: capture-block delete

- [ ] 1.1 Add `DELETE /v1/capture-blocks/:id` to
  `gateway/lib/capture-block-handlers.js` (`routeCaptureBlocks` currently
  branches only on `GET`, see `design.md` §5), token-protected and scoped to
  the block's owning session; tombstone the block rather than purging bytes.
- [ ] 1.2 Cancel any pending routing proposal (`file_only`/`unclassified`) on
  the deleted block.
- [ ] 1.3 Exclude tombstoned blocks from `list`, `search`, and `:id` GET
  reads.
- [ ] 1.4 Add deterministic smoke coverage: delete-then-list absence,
  delete-then-detail 404/410, cross-session delete rejection, and that the
  underlying storage/retention job is untouched by delete alone.
- Acceptance: a deleted capture block is unreachable through every existing
  GET route within the same request cycle, and a token from a different
  session cannot delete it.
- Verification: `cd gateway && npm run check` plus the new focused smoke.

## 2. Android: recording-active companion state

- [ ] 2.1 Add a mic-hardware-open signal to `OrbView` that composes with, and
  takes priority over, the existing `LISTENING_RIM`/`RECORDING_TINT` states
  (`OrbView.java:41-45`, `:223-250`) and is exempted from whatever opacity
  floor the ribbon-redesign lane applies to the companion in `dormant`
  (target: no less than 0.7).
- [ ] 2.2 Wire the signal to `AudioRecord.startRecording()`/stop in
  `MoaAudioCaptureController` (`:238-261`, `:81-133`), including the
  continuous-loop re-arm path (`OverlayService.java:1536-1549`,
  `:3900-3915`) and the pre-roll warm window.
- [ ] 2.3 Confirm the existing tap-to-toggle-capture hit target
  (`OverlayService.java` voice-first gesture handling) is unchanged in size
  and reachability when the companion is at `dormant` base opacity showing
  the recording-active overlay.
- [ ] 2.4 Add a one-tap review affordance for the single most-recent capture
  block after capture stops, showing its literal transcript and a Delete
  action bound to the route from section 1; do not build a browsing list.
- [ ] 2.5 Add unit coverage for signal composition (recording-active +
  existing listening/recording-note states) and for the opacity floor.
- Acceptance: with the mic hardware open, the companion shows the
  recording-active visual at ≥0.7 opacity even when the rest of the overlay is
  at rest (`dormant`), a tap stops capture using the existing gesture, and the
  following tap shows that capture's transcript with a working Delete action.
- Verification: Android unit tests, `assembleDebug`, and physical-phone QA
  covering a continuous-loop re-arm without a fresh gesture.

## 3. Browser: recording-active companion state and toolbar fallback

- [ ] 3.1 Extend `.listening`/`.recording` (`overlay.css:627-644`) with the
  same 0.7-floor override so the companion's recording-active visual survives
  whatever `dormant`-equivalent state the ribbon redesign introduces in the
  browser overlay.
- [ ] 3.2 Add a `chrome.action.setBadgeText`/`setBadgeBackgroundColor` call in
  `background.js`, driven by the same mic-hardware-open signal the offscreen
  recorder already tracks (`offscreen.js:98-116`), with no existing call to
  reuse — confirmed none exists today (`design.md` §1.4).
- [ ] 3.3 Confirm the existing tap/click-to-toggle-capture control is
  unchanged in size and reachability under the recording-active visual.
- [ ] 3.4 Add a one-tap review affordance for the single most-recent capture
  block after capture stops, matching 2.4's scope.
- [ ] 3.5 Add coverage: toolbar badge appears/clears with capture
  start/stop, including when the overlay tab is backgrounded or the overlay
  was never injected in the active tab.
- Acceptance: starting capture from any tab sets the toolbar badge and, once
  the overlay is visible, the in-page companion signal; switching to a tab
  without the overlay injected still shows the toolbar badge for as long as
  capture is active; stopping capture clears both within one state broadcast.
- Verification: `cd browser_extension && npm run verify && npm run smoke`,
  plus manual cross-tab QA of the toolbar badge.

## 4. Finish and promotion

- [ ] 4.1 Update `ARCHITECTURE.md` only if this lands with an
  architecture-significant change beyond what it already documents about
  capture-only turns and capture blocks (`ARCHITECTURE.md:43-47`, `:89-94`).
- [ ] 4.2 Run narrow verification per surface, commit each coherent unit with
  Conventional Commits.
- [ ] 4.3 Create isolated gateway preview state and an Android OTA artifact
  before any active promotion.
- [ ] 4.4 Prove rollback, old/new capture-block read/write compatibility
  (a client running old code must not break against the new DELETE route
  simply existing), and that no in-flight capture is interrupted by the
  rollout.
- [ ] 4.5 Promote only after the active-promotion gate passes; otherwise
  record the exact preview/artifact and blocker.

## Explicitly out of scope (see `proposal.md` and `design.md` §6)

- Any change to gesture bindings.
- The Android capture notebook, writing-skill copy variants, or the
  voice-first IME (`voice-capture-notebook-ime` sections 2-4).
- Retroactively deleting, redacting, or flagging any existing recording,
  including the 07-18 turns that motivated this change.
- Any local Android `TextToSpeech` path.
- A native macOS recording indicator (no native macOS app exists in this
  checkout to add one to).
