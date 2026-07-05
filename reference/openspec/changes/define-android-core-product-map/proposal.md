## Why

The Android app already has enough working pieces to become the first real Moa surface, but the product target is still scattered across logs, docs, and implementation details. This change makes the Android-first product map explicit before more code is added, so future implementation moves toward a coherent assistant instead of another pile of features.

## What Changes

- Define the Android core product as a phone-level voice and control surface, not a normal chat app.
- Establish the five core capabilities that must hold together: overlay voice surface, server-side voice routing, observable home-machine agent work, phone-local action runtime, and full-app control center.
- Turn the current implementation into a staged roadmap with acceptance criteria and verification checks.
- Preserve the trust boundary: the phone owns UI, permissions, approvals, and phone actions; the gateway/execution machine owns model access, memory, and long-running agents.
- Support standard Android assistant and voice-command launch paths for system gestures and compatible earbuds/headsets.
- Defer non-core work such as custom earbuds hardware, raw audio retention, marketplace integrations, and polished hosted TTS until the Android loop is usable.

## Capabilities

### New Capabilities

- `android-overlay-voice-surface`: Always-available Android overlay for fast speech capture, transcript display, stop behavior, and minimal interruption.
- `voice-agent-router`: Gateway-owned routing of spoken turns into chat, agent runs, multi-agent work, or local control.
- `agent-run-observability`: Mobile-visible lifecycle for home-machine agent runs started from voice or chat.
- `phone-action-runtime`: Approval-gated phone-local action model for screen reading, navigation, taps, API actions, and audit receipts.
- `full-app-control-center`: Full Android app surface for inspecting sessions, branches, runs, settings, approvals, and history.

### Modified Capabilities

- None. This is the first OpenSpec product map for the Android app.

## Impact

- Android app: `android_app/app/src/main/java/ai/moa/assistant/*`, especially `OverlayService`, `MainActivity`, `MoaGatewayClient`, `MoaActionBroker`, and accessibility service code.
- Gateway: `gateway/server.js` for voice turns, agent runs, session state, run status, cancellation, and action proposals.
- Docs: Android README/index/boundary docs should align to this map after implementation starts.
- Verification: Android debug build, gateway smoke checks, and manual phone QA for overlay/voice/run behavior, including AirPods/headset assistant gesture launch where available.
