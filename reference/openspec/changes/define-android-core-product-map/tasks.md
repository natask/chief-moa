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
- [ ] 9.6 Enforce OTA-only Android installation and updates. Remove or disable
      direct ADB install from the deployment path.
- [x] 9.7 Record deploy version metadata and monotonic target deploy sequences
      for gateway, Android OTA, and browser extension deploys; require changed
      browser-extension deploys to advance the manifest version after the first
      recorded extension deploy.
- [x] 9.8 Record the active Android distribution contract in the agent deployment
      context. The first install uses a debug APK over USB. OTA builds keep the
      same local debug certificate until a tested GitHub Actions key migration
      replaces this path.
- [x] 9.9 Make direct stable OTA publication fail closed on stale source: bind
      artifact metadata to the captured full commit SHA, require clean HEAD to
      contain both local `origin/master` and the uniquely resolvable deployed
      stable SHA, and recheck HEAD/cleanliness before publishing the exact built
      artifact. Deterministic wrapper tests cover accepted authority plus
      missing and unresolvable stable authority without network publication.

## 10. Cross-Device Tool Hub

- [x] 10.1 Define the gateway device-client registry: device id, surface type, session id, online status, local tool manifest, and last heartbeat.
- [x] 10.2 Define cross-device tool request/receipt records so a browser turn can request a phone action and a phone turn can request a browser action without bypassing local approval.
- [x] 10.3 Add Android device-client heartbeat and a minimal safe local tool manifest including `app.launch`, `system.back`, `system.home`, `screen.summary`, and `screen.tap_text`.
- [x] 10.4 Add browser extension device-client heartbeat and a safe local tool manifest including tab list/open/activate/close/reload, page-context snapshot, bounded `chrome.debugger` CDP execution, queued browser task claim/receipt, and local receipts.
- [x] 10.5 Add gateway APIs for listing active agents/runs/tool executions from any surface.
- [x] 10.6 Add a first cross-device smoke: browser requests Android to speak a short message; Android validates locally, speaks it, and receipts it through the gateway. Verified with `cd gateway && npm run smoke:device-hub`, plus Android and extension build/verify checks.

## 11. Reviewable Cross-Surface Overlay Controls (Superseded)

- [x] 11.1 Establish the original `X` and `↑` review-before-send controls. This
      interaction was superseded and removed by the accepted manual gesture
      contract in 12.4.
- [x] 11.2 Establish the original tap-resolution guard. This was superseded by
      the origin-matched single/double toggle and triple-click cancellation in
      section 12.
- [x] 11.3 Keep chat and voice cards mutually exclusive and dock the open card
      wholly above the orb, including while the orb moves, repositioning the
      orb down when the measured card plus gap would not otherwise fit.
- [x] 11.4 Add drag-to-remove plus explicit chat-header and notification Hide actions.
- [x] 11.5 Verify Android unit tests, `assembleDebug`, and strict OpenSpec validation.
- [ ] 11.6 Publish the committed Android OTA artifact and verify its update metadata.
- [x] 11.7 Place the original Android draft controls beside the orb instead of in
      the voice card. These controls were later removed by 12.4.
- [x] 11.8 Give the original browser voice-first mascot matching side controls.
      These controls were later removed by 12.4.
- [x] 11.9 Verify and package the browser extension parity slice.
- [x] 11.10 Coalesce Android orb, active-card, and draft-control relayouts to
      display frames while dragging; do no relayout before touch slop, keep the
      card always wholly above the orb (pushing the orb down when needed, never
      flipping the card below), and evaluate the visible bottom remove target
      against the final release position.

Historical acceptance check: with either chat or voice open, drag the orb rapidly
across and down the display. The orb, the single open card, and the then-current
draft controls followed together without per-MotionEvent relayout churn;
releasing outside the bottom target kept the overlay, while releasing inside
stopped it. Section 12 superseded and removed those draft controls.
Verified 2026-07-16: Android JVM tests and `assembleDebug` passed; strict
OpenSpec validation passed. Real-device frame pacing and drop-target feel remain
the manual QA check.

- [x] 11.11 Replace the physically laggy companion-only drag optimization with
      one bounded compact root containing the companion, current-turn ribbons,
      and the then-current draft controls. Prove that a coalesced moving frame
      makes exactly one WindowManager layout submission while preserving touch
      pass-through outside the root, streaming state, removal, and Undo.

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
- [x] 12.8 Remove the regressed Android X/Send control path and its orb-x clamp;
      retain origin-matched gesture disposition, TalkBack Send/Discard actions,
      and the `Record again` retry path, with JVM regressions for no side controls
      and stable initial x.

## 13. Stable Mobile Overlay Presentation

- [x] 13.1 Keep the idle orb at low opacity and reveal it while touched.
- [x] 13.2 Keep the remove target fully inside the display and dim it when the
      orb leaves the active drop zone.
- [x] 13.3 Give the transcript a fixed scrollable viewport and expose a durable
      Text/Voice reply toggle in its header, including the open streaming
      session rather than only future connections.
- [ ] 13.4 Complete physical-phone QA for system-inset placement, scroll touch,
      low-opacity discoverability, TTS delivery, and drag-to-remove behavior.
- [x] 13.5 Give the current user voice row an explicit Copy control that places
      the exact transcript on the Android clipboard and shows a visible copied
      receipt. If capture is still live, Copy commits the utterance, waits for
      the authoritative final transcript, and copies that complete result rather
      than a partial provider hypothesis.
- [ ] 13.6 Publish and physically smoke the transcript-copy Android OTA.
- [x] 13.7 Make every Android overlay launch path reuse one process owner and
      one orb window; apply the existing 70% default size and live size refresh,
      use 30% idle opacity, and preserve hold-drag and drag-to-remove geometry.
- [x] 13.8 Present the current turn as diagonal conversation bubbles anchored
      to the companion centerline: user above/right, assistant below/left, with
      inward edge clamps. Bound collapsed text to five lines, make expansion
      vertically scrollable, and expose one persistent user Copy action plus a
      separate History action without a hidden double-tap duplicate. Verify the
      actions through Android 8 accessibility as well as touch.
- [x] 13.9 Supersede the compact Copy/History rails with the History-first
      product contract. Lay out only the bounded visible tail while collapsed,
      retain the complete turn for expansion and full-app History, and expose no
      compact touch or Android 8 accessibility action for Copy or History.
- [x] 13.10 Restore one visible Copy action to the live user bubble after direct
      product feedback showed that History-only copy is too difficult to reach.
      Copy during capture commits, waits for the authoritative final transcript,
      and copies the complete message; History remains in the full app.
- [ ] 13.11 Wire the existing durable voice-draft capability into Android pause
      and resume controls. Pause must stop microphone capture without sending,
      discarding, or terminating the draft; resume must append to the same draft.

Release evidence: commit `b99379b0` built candidate
`ai.moa.assistant-1784945955` (`0.1.1784945955`, 4,265,050 bytes, SHA-256
`a5f0692eab128ad0e257458e5acd82275e6537ac62f7770e76a34bb31f5e969d`).
The VPS backup/preflight gate failed before publication, so the active OTA head
did not move. No authorized phone was attached; the candidate is neither
installed nor physically smoked.

## 14. Overlay-First Android Invocation

- [x] 14.1 Route the normal launcher icon through the thin Assistant activity
      instead of rendering the full control center.
- [x] 14.2 Make launcher, Assistant, voice-assist, and voice-command invocations
      start/commit one manual latched turn without silence auto-submit or re-arm.
- [x] 14.3 Keep orb hold/release as push-to-talk while an invoked turn is open.
- [x] 14.4 Keep the control center reachable through the explicit launcher
      Settings shortcut, notification, Quick Settings, and spoken/typed "show
      app UI" commands.
- [ ] 14.5 Complete physical-phone QA for launcher reuse, repeated Assistant
      invocation, orb click commit, orb hold/release, and permission hints.

Verification evidence: Android JVM tests and `assembleDebug` pass. The merged
APK manifest has exactly one `MAIN`/`LAUNCHER` entry on `MoaAssistActivity`;
`MainActivity` has none. Strict OpenSpec validation is locally blocked because
the installed CLI cannot import its `commander` dependency.

## 15. Mobile Voice Finish Recovery

- [x] 15.1 Make normal push-to-talk release commit the owned streaming
      controller exactly once instead of gating finish on transient transport
      activity.
- [x] 15.2 Keep Android `ACTION_CANCEL`, hold-drag cancellation, discard, and
      barge-in replacement as explicit non-commit paths.
- [x] 15.3 Give unexpected voice and private-turn startup failures one
      accessible, generation-bound `Record again` action.
- [x] 15.4 Add deterministic gesture/session tests for capture then normal
      finish, intentional cancellation, deferred startup, stale close, and
      one-shot retry.
- [ ] 15.5 Complete physical-phone QA and confirm gateway evidence contains one
      `commit_turn` and no `cancel_turn` for a normal hold/release turn.

## 16. Mobile Voice End-to-End Benchmark Evidence

- [x] 16.1 Add content-free Android lifecycle timings from actual microphone,
      socket/result, AudioTrack playback, drain, and terminal seams.
- [x] 16.2 Replace fixed-delay playback completion with bounded playback-head
      drain confirmation and an explicit timeout outcome.
- [x] 16.3 Retain at most 100 private on-device terminal samples and expose
      completion/failure/teardown, audible-success, p50, and p95 in the full app.
- [x] 16.4 Hash existing session/turn identity for local lifecycle correlation;
      never retain raw identity, content, credentials, URLs, or exception text.
- [x] 16.5 Add deterministic ordering tests for PCM receipt, audio-done drain
      ownership, immediate turn completion, disabled playback, playback errors,
      post-terminal suppression, and concurrent metrics retention.
- [x] 16.6 Move streamed assistant PCM writes to a bounded generation-scoped
      FIFO; admit playback text/progress only after queue acceptance and preserve
      provider/device drain, playback-head reveal, replacement, and TTS retry
      ordering.
- [ ] 16.7 Establish the real-phone benchmark with repeated audible success,
      playback-disabled, cancel/replacement, connection-loss, and drain-timeout
      trials against the exact installed APK.

## 17. Android App Display Name

- [x] 17.1 Present the Android app name as exactly `AG`, without dots, across
      the launcher, Assistant chooser, Quick Settings, accessibility and media
      service settings, overlay/chat UI, notifications, shortcuts, clipboard
      labels, and user-facing setup/update copy.
- [x] 17.2 Preserve the existing application id, package and service class
      names, signer continuity, update authority, protocol source identifiers,
      gateway headers, and routing vocabulary.
- [x] 17.3 Verify the focused naming assertions plus Android unit tests, lint,
      and debug assembly, then build a local candidate without publishing or
      installing it.

## 18. Model-Driven Android Useful Actions

- [x] 18.1 Prove model-driven Android proposals and durable receipts across
      typed chat, HTTP voice, cascaded voice, LiveKit reasoning, and legacy
      native Live for app launch/list, URL opening, dialing, contacts, media,
      and the fixed accessibility primitives.
- [x] 18.2 Keep `phone_action` available to both Android and browser native
      Live turns for explicit cross-device requests; keep multiple-phone
      selection ambiguous and screen actions without a fresh bound observation
      fail-closed before queueing.
- [x] 18.3 Route explicit spoken playlist mutations through the conversational
      phone-tool loop instead of diverting them to a workstation agent run,
      while preserving agent routing for playlist implementation work.
- [ ] 18.4 Complete physical-phone QA for resolved Android handlers, contacts
      permission, notification-listener access, accessibility approval and
      package/window binding, and gateway receipt synchronization.

Verification evidence: the deterministic voice-intent classifier smoke and
`smoke:surface-entrypoints`, `smoke:surface-skills`, and the full gateway check
pass. The entrypoint smoke claims every queued proposal as the compatible
Android device, submits the device receipt, and verifies gateway
acknowledgement. Focused Android action/accessibility/media/receipt unit tests
and `assembleDebug` also pass. Physical-phone QA remains open and is not
implied by this deterministic proof. Strict OpenSpec validation remains locally
blocked because the installed CLI cannot import its `commander` dependency.

## 19. History-First Full App Shell

- [x] 19.1 Build from current `origin/master` and retain its companion-between-
      ribbons overlay rather than rebasing UI work onto the stale device-preview
      branch.
- [x] 19.2 Make canonical History the default full-app destination with one
      page scroll and no nested fixed-height history viewport.
- [x] 19.3 Move setup, gateway, release, raw lifecycle, metrics, sizing, and
      gesture controls behind explicit Setup & developer navigation.
- [x] 19.4 Keep retained message text selectable and add an exact Copy turn
      action with a visible copied receipt.
- [x] 19.5 Stop ordinary full-app open/resume from starting or collapsing the
      overlay; explicit assistant and overlay launch paths remain unchanged.
- [ ] 19.6 Complete physical-phone visual QA for hierarchy, copy behavior,
      long-history scrolling, overlay independence, and back-and-forth section
      navigation.

Observable acceptance check: opening AG shows a clean History page without
implementation status rows. Setup & developer reveals the existing operational
controls. Copy turn copies the exact retained text. Merely opening or resuming
the full app does not mutate the overlay.

## 20. Temporary Gateway-Token Bootstrap

- [x] 20.1 Read `MOA_ANDROID_BUNDLED_GATEWAY_TOKEN` only at build time and
      expose an empty default through `BuildConfig.BUNDLED_GATEWAY_TOKEN`.
- [x] 20.2 Use the bundled value only when the saved gateway token is empty.
      Keep a non-empty saved user token authoritative.
- [x] 20.3 Keep every literal token out of tracked Gradle, source, test,
      documentation, and deployment files.
- [x] 20.4 Expose only current Android OTA manifest and latest APK reads without
      authentication, including app-channel equivalents. Keep version-pinned
      reads, rollback, publication, every mutation, and all non-OTA gateway
      routes protected.
- [ ] 20.5 Replace the shared bearer with account sign-in and revocable,
      scoped per-user/device credentials for chat, history, voice, and OTA
      onboarding.

Observable acceptance check: focused Android tests prove empty saved state uses
the build fallback, a saved token overrides it, and an empty build fallback
remains tokenless. An unauthenticated client can read only the current Android
OTA manifest and latest APK. It cannot read a version-pinned APK or call
rollback, publication, another mutation, or a non-OTA gateway route.

## 21. Launcher Literal Dictation

- [x] 21.1 Route only the normal `MAIN` launcher entry into a
      transcription-only streaming turn; keep Android Assistant and
      voice-command intents reasoning-capable.
- [x] 21.2 On successful finalization, copy the exact authoritative transcript.
- [x] 21.3 Paste only when Accessibility proves the same non-sensitive focused
      editor remains current; otherwise keep the clipboard-only result.
- [x] 21.4 Keep first launch as start and repeated launch as explicit commit,
      with no silence auto-submit.
- [ ] 21.5 Complete physical-phone QA for clipboard fallback, same-field cursor
      insertion, changed focus, password refusal, repeated launch commit, and
      Assistant-mode separation.

Observable acceptance check: launching AG starts literal dictation without
reasoning or TTS. Launching again commits, copies the complete final transcript,
and inserts it only into the still-focused safe editor. Android Assistant still
starts a normal assistant voice turn.

## 22. Latency-Tolerant Cascaded Voice

- [x] 22.1 Replace the cascaded reasoner's fixed total-duration deadline with a
      bounded inactivity deadline.
- [x] 22.2 Reset that deadline on streamed speech, style, and interim tool
      acknowledgment activity while keeping a silent provider bounded.
- [x] 22.3 Keep gateway `turn_progress` events as the client-facing liveness
      signal during both long reasoning and hosted TTS.

Observable acceptance check: a deterministic reasoning operation that remains
active across multiple timeout windows completes, while an operation that emits
no activity for one full deadline fails with an explicit inactivity timeout.
