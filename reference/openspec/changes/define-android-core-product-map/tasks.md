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

## 8. Verification Harness

- [x] 8.1 Add gateway smoke commands for health, voice turn, agent run list, and run detail.
- [x] 8.2 Keep `./gradlew assembleDebug` as Android compile verification.
- [x] 8.3 Add manual QA checklist for overlay tap, double tap stop, transcript, agent run start, run status, and wake restart.
- [x] 8.4 Add manual QA for AirPods/headset assistant gesture: reinstall APK, clear any prior voice-command default, trigger the earbud gesture, select Moa, and verify the overlay transcript starts.

## 9. Android OTA Deployment

- [x] 9.1 Add versioned Android APK OTA artifact generation.
- [x] 9.2 Serve latest Android update metadata and APK from the gateway behind gateway token auth.
- [x] 9.3 Add full-app update check, APK checksum verification, and package-installer handoff.
- [x] 9.4 Add commit-triggered GitHub Actions build and main-machine OTA deploy workflow.
- [x] 9.5 Verify with Android debug build, gateway syntax check, OpenSpec validation, and a main-machine OTA smoke test. Verified 2026-06-20: `assembleDebug` BUILD SUCCESSFUL (app-debug.apk produced); `npm run check` ok with all profile/voice checks passing; `openspec validate define-android-core-product-map --strict` valid; OTA endpoint `/v1/android/updates/latest` serves version 0.1.1781720954 (git_sha 9719b68). Note: the served OTA build is from 2026-06-17; publishing a fresh OTA from current HEAD is a separate deploy step.
