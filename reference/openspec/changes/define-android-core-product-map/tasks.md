# Tasks

## 1. Product Map And Spec Baseline

- [x] 1.1 Initialize OpenSpec for `moa-assistant`.
- [x] 1.2 Create the `define-android-core-product-map` change.
- [x] 1.3 Write proposal, design, capability specs, and implementation waves.
- [x] 1.4 Validate the OpenSpec change.

## 2. Agent Run Observability Slice

- [x] 2.0 Register Moa for Android `VOICE_COMMAND` assistant launches so AirPods/headset voice-command choosers can offer Moa.
- [x] 2.1 Change Android-created agent runs to `wait=false`.
- [x] 2.2 Extend `MoaGatewayClient` with `GET /v1/agent/runs` and `GET /v1/agent/runs/:id`.
- [x] 2.3 Track run IDs returned by `/v1/voice/turns` and `/v1/agent/runs`.
- [x] 2.4 Show active run count/status in the overlay panel.
- [x] 2.5 Poll active runs until terminal status and append a concise completion message.
- [x] 2.6 Verify with gateway smoke checks and Android debug build.

## 3. Gateway Run Lifecycle Controls

- [x] 3.1 Add a cancellation endpoint for active agent runs.
- [x] 3.2 Persist cancellation events in the agent-run event log.
- [x] 3.3 Return lifecycle-safe summaries for queued, running, completed, failed, timed-out, and canceled runs.
- [x] 3.4 Verify with a short fake or harmless harness command.

## 4. Session, Branch, And Voice Event Model

- [x] 4.1 Define the canonical event fields for voice turns, chat turns, agent runs, and action receipts.
- [x] 4.2 Ensure Android sends stable `session_id`, `branch_id`, and `turn_id`.
- [x] 4.3 Ensure gateway responses echo those identifiers consistently.
- [x] 4.4 Add a lightweight session summary endpoint for the full app.
- [x] 4.5 Support starting a new voice session or branch while another run is active without forcing an in-memory merge.
- [x] 4.6 Expose persisted session/run/action context for code-mode agents through a gateway-readable store or endpoint.
- [x] 4.7 Evaluate Postgres as the canonical gateway store for sessions, turns, runs, executions, approvals, and receipts.
- [x] 4.8 Evaluate DBOS for durable gateway workflows, queues, recovery, dedupe, and cancellation.

## 5. Phone Action Runtime

- [x] 5.1 Create a local static capability manifest for phone actions.
- [x] 5.2 Add approval decisions for read-only, navigation, external side effects, and blocked sensitive actions.
- [x] 5.3 Convert `/tap`, `/back`, and `/home` into receipt-producing actions.
- [x] 5.4 Add local receipt storage with a simple hash chain.
- [x] 5.5 Keep model-proposed actions inert until validated and approved locally.
- [x] 5.6 Evaluate an Executor-compatible gateway adapter for OpenAPI, MCP, GraphQL, and custom function tool sources.

## 6. Full App Control Center V0

- [x] 6.1 Replace the current setup-only home screen with tabs or sections for Setup, Sessions, Runs, Approvals, and Settings.
- [x] 6.2 Show current gateway health and harness availability.
- [x] 6.3 Show recent voice turns and active/completed runs.
- [x] 6.4 Show action receipts and pending approvals.
- [x] 6.5 Keep all controls usable on a phone without covering text or controls.

## 7. Voice Quality Upgrade

- [x] 7.0 Keep the streaming overlay at one line by default, allow a bounded
      five-line expansion, and keep History and Copy visible without stacking
      durable history over the current app.
- [ ] 7.0a Add gateway-owned, non-executing cleaned and structured transcript
      proposals with source/provenance fields, then expose them as explicit
      overlay actions after endpoint smoke coverage exists.

- [x] 7.1 Keep Android `SpeechRecognizer` as the baseline path.
- [x] 7.2 Add an abstraction boundary for future streaming STT and hosted TTS.
- [x] 7.3 Add a setting to mute spoken replies while preserving full display text.
- [x] 7.4 Evaluate hosted TTS only after observability and action boundaries are in place.
- [x] 7.5 Route Android Live voice profile-control utterances (voice/language
      changes) through the gateway profile-control path so they persist and
      apply to the next Live turn with prior context.
- [x] 7.6 Persist hard voice, heard-language, reply-language, and response
      behavior settings either globally for all devices or as current-device
      overrides, and require mission agents to ask for missing access instead of
      giving flat refusals.
- [x] 7.7 Back hard voice/language settings with a gateway options catalog so
      agents and clients can list supported voices/languages dynamically, map
      masculine/feminine tone requests to valid voice ids, and reject unsupported
      profile values before persistence.

## 8. Verification Harness

- [x] 8.1 Add gateway smoke commands for health, voice turn, agent run list, and run detail.
- [x] 8.2 Keep `./gradlew assembleDebug` as Android compile verification.
- [x] 8.3 Add manual QA checklist for overlay tap, release-to-send voice capture, transcript, agent run start, run status, and wake restart.
- [x] 8.4 Add manual QA for AirPods/headset assistant gesture: reinstall APK, clear any prior voice-command default, trigger the earbud gesture, select Moa, and verify the overlay transcript starts.

## 9. Android OTA Deployment

- [x] 9.1 Add versioned Android APK OTA artifact generation.
- [x] 9.2 Serve latest Android update metadata and APK from the gateway behind gateway token auth.
- [x] 9.3 Add full-app update check, APK checksum verification, and package-installer handoff.
- [x] 9.4 Add commit-triggered GitHub Actions build and main-machine OTA deploy workflow.
- [x] 9.5 Verify with Android debug build, gateway syntax check, OpenSpec validation, and a main-machine OTA smoke test. Verified 2026-06-20: `assembleDebug` BUILD SUCCESSFUL (app-debug.apk produced); `npm run check` ok with all profile/voice checks passing; `openspec validate define-android-core-product-map --strict` valid; OTA endpoint `/v1/android/updates/latest` serves version 0.1.1781720954 (git_sha 9719b68). Note: the served OTA build is from 2026-06-17; publishing a fresh OTA from current HEAD is a separate deploy step.
- [x] 9.6 Keep OTA publish as the deploy source of truth and install the published APK directly over ADB when an authorized phone is connected; skip direct install without failing when no device is available.
- [x] 9.7 Record deploy version metadata and monotonic target deploy sequences
      for gateway, Android OTA, and browser extension deploys; require changed
      browser-extension deploys to advance the manifest version after the first
      recorded extension deploy.
- [x] 9.8 Record the active Android distribution contract in the agent deployment
      context. The first install uses a debug APK over USB. OTA builds keep the
      same local debug certificate until a tested GitHub Actions key migration
      replaces this path.

## 10. Cross-Device Tool Hub

- [x] 10.1 Define the gateway device-client registry: device id, surface type, session id, online status, local tool manifest, and last heartbeat.
- [x] 10.2 Define cross-device tool request/receipt records so a browser turn can request a phone action and a phone turn can request a browser action without bypassing local approval.
- [x] 10.3 Add Android device-client heartbeat and a minimal safe local tool manifest including `app.launch`, `system.back`, `system.home`, `screen.summary`, and `screen.tap_text`.
- [x] 10.4 Add browser extension device-client heartbeat and a safe local tool manifest including tab list/open/activate/close/reload, page-context snapshot, bounded `chrome.debugger` CDP execution, queued browser task claim/receipt, and local receipts.
- [x] 10.5 Add gateway APIs for listing active agents/runs/tool executions from any surface.
- [x] 10.6 Add a first cross-device smoke: browser requests Android to speak a short message; Android validates locally, speaks it, and receipts it through the gateway. Verified with `cd gateway && npm run smoke:device-hub`, plus Android and extension build/verify checks.

## 11. Reviewable Cross-Surface Overlay Controls

- [x] 11.1 Show `X` and `↑` controls for every tap-started Android voice draft.
- [x] 11.2 Prevent single-, double-, triple-, and fourth-tap resolution from
      silently committing a draft; keep hold-release as the fast commit path.
- [x] 11.3 Keep chat and voice cards mutually exclusive and dock the open card
      wholly above the orb, including while the orb moves, repositioning the
      orb down when the measured card plus gap would not otherwise fit.
- [x] 11.4 Add drag-to-remove plus explicit chat-header and notification Hide actions.
- [x] 11.5 Verify Android unit tests, `assembleDebug`, and strict OpenSpec validation.
- [ ] 11.6 Publish the committed Android OTA artifact and verify its update metadata.
- [x] 11.7 Place Android draft controls beside the orb instead of in the voice card.
- [x] 11.8 Give the browser voice-first mascot matching side controls and prevent
      a later mascot click from silently sending the draft.
- [x] 11.9 Verify and package the browser extension parity slice.
- [x] 11.10 Coalesce Android orb, active-card, and draft-control relayouts to
      display frames while dragging; do no relayout before touch slop, keep the
      card always wholly above the orb (pushing the orb down when needed, never
      flipping the card below), and evaluate the visible bottom remove target
      against the final release position.

Observable acceptance check: with either chat or voice open, drag the orb rapidly
across and down the display. The orb, the single open card, and any draft controls
follow together without per-MotionEvent relayout churn; releasing outside the
bottom target keeps the overlay, while releasing inside stops it.
Verified 2026-07-16: Android JVM tests and `assembleDebug` passed; strict
OpenSpec validation passed. Real-device frame pacing and drop-target feel remain
the manual QA check.

Release note: commit `5106d52` produced Android artifact
`android-ota-5106d52d7fcc527ee05b0c2197c1b8b38124eb52-1` and browser artifact
`agee-chrome-0.1.35-5106d52d7fcc527ee05b0c2197c1b8b38124eb52`.
The Android CI artifact from this release proves the build only. The active
direct-distribution path still uses the local continuity signer and VPS OTA
publisher. GitHub Actions publication requires a tested signer migration. The
Chrome Web Store upload gate was skipped. The local unpacked-extension reload
signal completed without a client acknowledgement.

## 12. Manual Cross-Surface Voice Gestures

- [x] 12.1 Make single click start/stop-and-send current-thread capture.
- [x] 12.2 Make hold/release push-to-talk in the same thread and preserve
      hold-drag cancellation.
- [x] 12.3 Make double-click start/stop-and-send fresh-thread capture; cancel an
      active current-thread capture without sending before the fresh start.
- [x] 12.4 Make triple-click cancel without sending and open chat; remove the
      superseded Android and browser X/Send draft controls.
- [x] 12.5 Verify Android unit tests and `assembleDebug`, plus browser verify and
      real headless-Chrome smoke, from the isolated integration candidate.
- [ ] 12.6 Complete physical-phone timing, touch-slop, interruption, mode, and
      real voice round-trip QA.
- [ ] 12.7 Publish collision-free Android OTA and browser-extension artifacts,
      then promote only if the no-interruption and rollback gates pass.

## 13. Stable Mobile Overlay Presentation

- [x] 13.1 Keep the idle orb at low opacity and reveal it while touched.
- [x] 13.2 Keep the remove target fully inside the display and dim it when the
      orb leaves the active drop zone.
- [x] 13.3 Give the transcript a fixed scrollable viewport and expose a durable
      Text/Voice reply toggle in its header, including the open streaming
      session rather than only future connections.
- [ ] 13.4 Complete physical-phone QA for system-inset placement, scroll touch,
      low-opacity discoverability, TTS delivery, and drag-to-remove behavior.
- [x] 13.5 Give each finalized voice row an explicit Copy control that places
      the exact transcript on the Android clipboard and shows a visible copied
      receipt; keep partial streaming rows non-copyable until finalized.
- [ ] 13.6 Publish and physically smoke the transcript-copy Android OTA.

Release evidence: commit `b99379b0` built candidate
`ai.moa.assistant-1784945955` (`0.1.1784945955`, 4,265,050 bytes, SHA-256
`a5f0692eab128ad0e257458e5acd82275e6537ac62f7770e76a34bb31f5e969d`).
The VPS backup/preflight gate failed before publication, so the active OTA head
did not move. No authorized phone was attached; the candidate is neither
installed nor physically smoked.

## 14. Mobile Voice Finish Recovery

- [x] 14.1 Make normal push-to-talk release commit the owned streaming
      controller exactly once instead of gating finish on transient transport
      activity.
- [x] 14.2 Keep Android `ACTION_CANCEL`, hold-drag cancellation, discard, and
      barge-in replacement as explicit non-commit paths.
- [x] 14.3 Give unexpected voice and private-turn startup failures one
      accessible, generation-bound `Record again` action.
- [x] 14.4 Add deterministic gesture/session tests for capture then normal
      finish, intentional cancellation, deferred startup, stale close, and
      one-shot retry.
- [ ] 14.5 Complete physical-phone QA and confirm gateway evidence contains one
      `commit_turn` and no `cancel_turn` for a normal hold/release turn.

## 15. Mobile Voice End-to-End Benchmark Evidence

- [x] 15.1 Add content-free Android lifecycle timings from actual microphone,
      socket/result, AudioTrack playback, drain, and terminal seams.
- [x] 15.2 Replace fixed-delay playback completion with bounded playback-head
      drain confirmation and an explicit timeout outcome.
- [x] 15.3 Retain at most 100 private on-device terminal samples and expose
      completion/failure/teardown, audible-success, p50, and p95 in the full app.
- [x] 15.4 Hash existing session/turn identity for local lifecycle correlation;
      never retain raw identity, content, credentials, URLs, or exception text.
- [x] 15.5 Add deterministic ordering tests for PCM receipt, audio-done drain
      ownership, immediate turn completion, disabled playback, playback errors,
      post-terminal suppression, and concurrent metrics retention.
- [ ] 15.6 Establish the real-phone benchmark with repeated audible success,
      playback-disabled, cancel/replacement, connection-loss, and drain-timeout
      trials against the exact installed APK.
- [x] 15.7 Move streamed assistant PCM onto one bounded generation-bound FIFO so
      WebSocket callbacks remain responsive, audio-done drains accepted frames,
      cancellation clears stale audio, and queue overflow is visible.
