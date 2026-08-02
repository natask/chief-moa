## 1. Contract Reconciliation

- [ ] 1.1 Reconcile the superseded no-side-control clauses in
  `voice-first-orb-gestures`, `quiet-companion-controls`, and
  `define-android-core-product-map` while preserving the bounded-ribbon and
  single-overlay-owner requirements; acceptance: no active spec gives two
  different stable meanings to the same Companion control.
- [ ] 1.2 Add pure typed domains for invocation behavior, presentation style,
  trigger identity, and phase-appropriate controls; acceptance: a focused unit
  test covers every row of the design decision tables and rejects unknown
  persisted values.

## 2. Android Invocation And Settings

- [ ] 2.1 Route launcher, Assistant intents, voice commands, quick tile, and
  app-owned shortcuts through one invocation coordinator; acceptance: each
  entry creates exactly one typed invocation and reuses one overlay owner.
- [ ] 2.2 Add launcher shortcuts for the supported subset of Settings,
  Dictation, Assistant, and Hands-free; acceptance: Settings starts no capture
  and each voice shortcut reaches its named behavior once.
- [ ] 2.3 Add full-app trigger mapping, presentation selection, platform-
  support status, and reset; acceptance: a saved supported mapping routes the
  next invocation and unsupported triggers remain explicitly unavailable.

## 3. Gateway Draft Prerequisite

- [ ] 3.1 Audit the existing voice-draft store, smokes, Android/browser protocol
  domains, WebSocket routing, capability advertisement, task ledger, and
  deployed state; then complete only the missing `voice-capture-draft-controls`
  integration. Acceptance: Pause/Resume/Discard before Send produces no
  provider, model, tool, broker, memory, or canonical turn record, and exact
  source plus deployment evidence identifies `voice_drafts_v1` as active or
  blocked.
- [ ] 3.2 Prove old Android against the additive gateway and new Android against
  a gateway without `voice_drafts_v1`; acceptance: old behavior remains usable
  and new pause controls disable honestly.

## 4. Companion Controls And Copy

- [ ] 4.1 Add one phase-derived Pause/Resume control and one Cancel control
  beside the mascot while keeping Send/turn handoff on the mascot; acceptance:
  capture, paused, thinking, and speaking fixtures expose only the controls
  permitted by the decision table and never render a second Send.
- [ ] 4.2 Wire draft Pause/Resume and discard with revision/authority checks;
  acceptance: resume appends to the same draft and cancel submits no commit.
- [ ] 4.3 Wire assistant playback pause/resume, conversational cancel, and
  mascot steering without affecting detached agent runs; acceptance: late old-
  generation frames cannot play or extend the current message after handoff.
- [ ] 4.4 Put exactly one Copy action inside every populated Android user and
  assistant message and remove duplicates; acceptance: each action copies its
  exact finalized message without a network or history mutation.

## 5. Minimal Ring

- [ ] 5.1 Add four bounded edge-window layout and touch-region domains with
  unit coverage; acceptance: center and nonrendered coordinates have no Ag
  window while every rendered edge stays on-screen across insets and rotation.
- [ ] 5.2 Render idle, mic-open, paused, thinking, speaking, and error states
  from hardware capture plus normalized phase; acceptance: microphone level
  changes bounded visual intensity without resizing or exposing content.
- [ ] 5.3 Capture deterministic light, dark, reduced-motion, and high-contrast
  states and run two independent Claude design critiques, recording actual model
  IDs; acceptance: the selected tokens have explicit dispositions for every
  critique and do not claim an unavailable model.
- [ ] 5.4 Wire Companion/Minimal switching without changing the owned turn;
  acceptance: switching during capture preserves one microphone, socket, turn,
  branch, and control state.

## 6. Edge-Gesture Experiment

- [ ] 6.1 Add a pure off-by-default edge resolver for candidate left-inward
  Pause/Resume, right-inward Send/handoff, and either-outward Cancel/Stop;
  acceptance: below-threshold, non-dominant, system-reserved, and disabled
  motions are inert.
- [ ] 6.2 Add a visible experimental setting, kill switch, gesture help, and
  named accessibility fallbacks; acceptance: a user can complete every control
  without an edge gesture and disabling the experiment restores ordinary system
  navigation immediately.
- [ ] 6.3 Run physical-phone QA under gesture and three-button navigation,
  TalkBack, rotation, light/dark apps, and screen edges; acceptance: record an
  explicit adopt/revise/reject decision before any stable default changes.

## 7. Provider Choice And Routed Follow-Ups

- [ ] 7.1 Add an Android selector backed only by gateway profile options and
  provider capabilities; acceptance: configured choices return a new profile
  version, unavailable choices explain why, and no raw key field exists.
- [ ] 7.2 Verify the browser mascot and compact Copy surface through the
  `overlay-companion-ribbons` / `quiet-companion-controls` package-and-reload
  path; acceptance: loaded-browser evidence proves the mascot and the chosen
  non-duplicated Copy placement.
- [ ] 7.3 Implement and measure gateway connection prewarm under
  `voice-latency-prewarm`; acceptance: a recorded cold/prewarmed comparison
  reports the actual commit-to-first-token or first-audio delta.

## 8. Verification, Integration, And Delivery

- [ ] 8.1 Run `node scripts/source-size-policy.js` and Android
  `lintDebug assembleDebug testDebugUnitTest`; acceptance: every command passes
  from the exact committed candidate.
- [ ] 8.2 Run focused gateway and browser gates for any prerequisite or routed
  follow-up actually included in the candidate; acceptance: `gateway npm run
  check` and/or browser `npm run verify && npm run smoke` pass as applicable.
- [ ] 8.3 Commit each independent unit in its isolated branch/worktree, run
  shared-file integrations in sequence, and integrate through
  `scripts/release/push-master.sh`; acceptance: no direct branch-to-master push,
  dirty-target deploy, or unrecorded idle worktree is used.
- [ ] 8.4 Create a continuity-signed, device-reachable Android preview for the
  exact candidate and physically test invocation, controls, touch pass-through,
  ring state, provider selection, and rollback; acceptance: artifact digest,
  signer, installed version, and phone-smoke evidence all bind the same commit.
- [ ] 8.5 Publish with `bash scripts/deploy.sh android` only after preview,
  rollback, no-interruption, lineage, and compatibility gates pass; acceptance:
  report built, packaged, published, installed, and smoked separately and record
  the blocker for every state not reached.
