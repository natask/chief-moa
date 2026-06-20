## 1. Provider Registry Baseline

- [x] 1.1 Add a gateway provider registry model for `native_live`, `stt`, `reasoning`, and `tts` providers with stable IDs and capability flags.
- [x] 1.2 Register existing `loopback` and `gemini-live` providers in the registry without changing the Android WebSocket protocol.
- [x] 1.3 Extend gateway health/runtime status to report selected provider mode, selected provider IDs, configuration status, and capability flags.
- [ ] 1.4 Add a provider-swap smoke test proving Android-facing event names remain stable when switching between configured providers.

## 2. Versioned Agent Profile

- [x] 2.1 Add a gateway `agent_profile` store with default profile derived from current system prompt, voice style, provider settings, language, tool policy, and memory policy.
- [x] 2.2 Record `profile_version` on voice turns, chat turns, and agent-run records.
- [x] 2.3 Add gateway endpoints to read current profile, list profile versions, update profile fields, and roll back to a previous version.
- [x] 2.4 Route explicit spoken profile-control intents to profile updates instead of normal chat responses.
- [x] 2.5 Add regression tests for profile update, rollback, and per-turn profile version recording. Verified by `gateway/scripts/smoke-voice-profile.js` and `gateway/scripts/smoke-live-browser-continuity.js`.

## 3. Explicit Language State

- [ ] 3.1 Add profile fields for explicit language mode, primary language, output language policy, and `auto_switch=false` default.
- [ ] 3.2 Translate language state into Gemini Live setup/prompt instructions and provider metadata without allowing silent durable language changes.
- [ ] 3.3 Add voice intents for switching language and asking which language is active.
- [ ] 3.4 Show active language state in the Android overlay or full-app settings.
- [ ] 3.5 Verify real phone behavior: language changes persist across turns and do not change until explicitly changed again.

## 4. Canonical Voice And Provider Events

- [ ] 4.1 Normalize voice-session events for transcript partial/final, assistant audio, speaking, interruption, completion, error, and profile application.
- [ ] 4.2 Persist normalized provider events with session, branch, turn, provider IDs, timestamps, and profile version.
- [ ] 4.3 Store or reference user and assistant audio artifacts per turn according to the existing local retention behavior.
- [x] 4.4 Add a gateway query path for current session, branch, turn, profile, provider events, runs, approvals, receipts, and memory summaries. Current JSON-file path includes voice turns, chat turns, profile, provider events, runs, browser tasks, approvals/receipts placeholders, and memory summary placeholder.
- [x] 4.5 Add smoke coverage proving a restarted provider session reconstructs context from Moa-owned history instead of provider-only memory. Verified by `gateway/scripts/smoke-live-interrupt-handoff.js`.

## 5. Continuous Overlay Voice Runtime

- [x] 5.1 Convert Android overlay voice handling into a normalized state machine: ready, listening, thinking, speaking, interrupted, recovering, and error.
- [x] 5.2 Keep the overlay session active after each completed turn regardless of launch path, including assistant/voice-command launch.
- [ ] 5.3 Compute a smoothed local microphone voice-level value from PCM chunks and feed it to the orb without resizing the overlay layout.
- [ ] 5.4 Render distinct orb states for user listening, assistant speaking, ready, and error/recovery.
- [x] 5.5 Keep partial/final transcript and assistant output visible during continuous conversation.
- [ ] 5.6 Verify on phone with screen recording: continuous turns, visible transcript, audio-reactive orb, and overlay remains open after response.

## 6. Interruption And Playback Control

- [x] 6.1 Normalize interruption events from Gemini Live and local playback stop into the same Moa runtime event. Gateway stores interrupted live turns as canonical conversation records and provider interruption events; local playback QA remains manual.
- [ ] 6.2 Stop or duck assistant playback when the user begins a new spoken turn during assistant audio.
- [ ] 6.3 Preserve active agent-run follow-up routing when the user speaks while an agent run is ongoing.
- [ ] 6.4 Add phone QA for barge-in or fallback interruption when provider-native barge-in is unavailable.

## 7. Safe Mode And Recovery

- [ ] 7.1 Add safe-mode endpoint and profile state that disables non-essential tools and switches to a known-good text or baseline voice path.
- [ ] 7.2 Add spoken and full-app controls for "safe mode", "reset your behavior", "cancel active runs", and "switch provider".
- [ ] 7.3 Record recovery events with trigger source, previous profile version, new profile version, affected runs, and provider state.
- [ ] 7.4 Verify recovery from a deliberately bad prompt/profile without editing environment files or restarting the app manually.

## 8. Modular Provider Path

- [ ] 8.1 Implement a modular voice runtime interface for STT -> reasoning -> TTS using the same normalized event stream.
- [ ] 8.2 Add one non-Gemini reasoning provider behind the gateway boundary with no Android protocol change.
- [x] 8.3 Add one non-Gemini STT or TTS provider behind the gateway boundary with capability metadata and fallback behavior.
- [ ] 8.4 Verify a provider-mix smoke path and compare transcript/audio/runtime events against Gemini Live.

## 9. Documentation And Validation

- [ ] 9.1 Update `ARCHITECTURE.md` with provider registry, agent profile, explicit language state, canonical memory, and recovery primitives.
- [ ] 9.2 Add a manual QA checklist for continuous voice, language switching, profile edit, provider swap, interruption, and recovery.
- [ ] 9.3 Run `openspec validate provider-agnostic-voice-agent-runtime --strict`.
- [ ] 9.4 Run gateway checks and Android build after the first implementation slice. Gateway verified 2026-06-20 with `cd gateway && npm run check`; Android build not rerun for this gateway/browser slice.
- [ ] 9.5 Deploy the first implementation slice to the main machine and verify phone E2E over the configured gateway.
