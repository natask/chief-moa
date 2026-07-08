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
- [x] 3.4 Show active language state in the Android overlay or full-app settings.
      Verified 2026-06-25 with `cd android_app && ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew testDebugUnitTest` and `cd android_app && ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew assembleDebug`.
- [ ] 3.5 Verify real phone behavior: language changes persist across turns and do not change until explicitly changed again.

## 4. Canonical Voice And Provider Events

- [ ] 4.1 Normalize voice-session events for transcript partial/final, assistant audio, speaking, interruption, completion, error, and profile application.
- [ ] 4.2 Persist normalized provider events with session, branch, turn, provider IDs, timestamps, and profile version.
- [ ] 4.3 Store or reference user and assistant audio artifacts per turn according to the existing local retention behavior.
- [x] 4.4 Add a gateway query path for current session, branch, turn, profile, provider events, runs, approvals, receipts, and memory summaries. Current JSON-file path includes voice turns, chat turns, profile, provider events, runs, browser tasks, approvals/receipts placeholders, and memory summary placeholder.
- [x] 4.5 Add smoke coverage proving a restarted provider session reconstructs context from Moa-owned history instead of provider-only memory. Verified by `gateway/scripts/smoke-live-interrupt-handoff.js`.
- [x] 4.6 Expose token-protected sent-message history/search and archived PCM playback refs for retained streaming voice turns.
      Verified 2026-06-28 with `cd gateway && node scripts/smoke-regression.js` and `cd gateway && npm run check`.

## 5. Continuous Overlay Voice Runtime

- [x] 5.1 Convert Android overlay voice handling into a normalized state machine: ready, listening, thinking, speaking, interrupted, recovering, and error.
- [x] 5.2 Keep the overlay session active after each completed turn regardless of launch path, including assistant/voice-command launch.
- [ ] 5.3 Compute a smoothed local microphone voice-level value from PCM chunks and feed it to the orb without resizing the overlay layout.
- [ ] 5.4 Render distinct orb states for user listening, assistant speaking, ready, and error/recovery.
- [x] 5.5 Keep partial/final transcript and assistant output visible during continuous conversation.
- [ ] 5.6 Verify on phone with screen recording: continuous turns, visible transcript, audio-reactive orb, and overlay remains open after response.

## 6. Interruption And Playback Control

- [x] 6.1 Normalize interruption events from Gemini Live and local playback stop into the same Moa runtime event. Gateway stores interrupted live turns as canonical conversation records and provider interruption events; local playback QA remains manual.
- [x] 6.2 Stop or duck assistant playback when the user begins a new spoken turn during assistant audio. Browser extension now stops queued assistant PCM sources when a new voice turn starts and ignores stale audio after a turn is replaced; Android streaming controller already stops playback on cancel/destroy. Verified 2026-06-20 with `cd browser_extension && npm run verify`, `cd browser_extension && npm run smoke`, `cd gateway && npm run check`, `cd android_app && ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew assembleDebug`, and a real main-machine voice-session smoke using spoken PCM that emitted transcript, assistant text/audio, and `turn_done`.
- [ ] 6.3 Preserve active agent-run follow-up routing when the user speaks while an agent run is ongoing.
- [ ] 6.4 Add phone QA for barge-in or fallback interruption when provider-native barge-in is unavailable.
- [x] 6.5 Add browser semi-interaction mode: a spoken session command enables background assistant speech so a new browser voice turn can start without stopping already queued assistant audio, while still using one durable session id and distinct turn ids. Verified 2026-06-20 with `cd browser_extension && npm run verify`, `cd browser_extension && npm run smoke`, `cd gateway && npm run check`, and `cd gateway && node scripts/smoke-regression.js`.

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

## 10. Voice Evidence QA And Forked Agent Sessions

- [ ] 10.1 Add a first-class voice evidence record that links a spoken turn to user audio, expected/observed transcript, assistant text/audio, provider IDs, profile version, retention policy, and pass/fail criteria.
- [ ] 10.2 Add an audio replay smoke that plays a fixture utterance through the gateway voice runtime, stores the observed transcript and assistant response, and emits a pass/fail verdict against expected criteria.
- [ ] 10.3 Add non-interrupting forked turn routing: a voice/chat turn can start a new `agent_run` with `wait=false` while existing active runs keep running.
- [ ] 10.4 Link subsequent user turns to relevant active runs as evidence or instruction, with a stored routing reason; irrelevant forks may self-dismiss with a no-op/dismissed result.
- [ ] 10.5 Expose active fork/run status so the user can ask which agents are active and what each is doing.

## 11. Stage A: Voice Product Contract And Diagnostics

- [ ] 11.1 Keep `voice-product-contract-notes.md` as the raw product-direction artifact for diagnosable failures, self-hostable logs, long-response audio reliability, first-audio latency, continuous partial STT, interruption context, profiles/modes, demos, gestures, shortcuts, and cache-friendly context.
- [ ] 11.2 Add normalized voice failure phase labels on gateway turn/provider events: capture, transport, STT, context, reasoning, TTS, playback, storage, and comparison.
- [ ] 11.3 Add a token-protected voice diagnosis read path that answers "why did voice fail?" from self-hosted gateway records, returning session, branch, turn, profile version, provider IDs, phase, timing, artifact refs, context-pack refs, and a user-facing summary.
- [ ] 11.4 Ensure provider-console logs are supplementary only: a self-hosted deployment with Postgres or JSON/JSONL fallback can diagnose the failure phases above from local gateway data.
- [ ] 11.5 Add deterministic smoke coverage for at least STT failure, reasoner failure, TTS failure, socket/transport drop, and storage failure; each smoke must assert the phase label and diagnosis response.
- [ ] 11.6 Verification: `cd gateway && npm run check` plus the new voice-diagnosis smoke, then `openspec validate provider-agnostic-voice-agent-runtime --strict`.

## 12. Stage B: Audio Reliability, Latency, And Partial STT

- [ ] 12.1 Add a first-audio latency metric to all voice provider results that can report it. For cascaded streaming, measure `first_audio_ms` from final transcript or explicit turn commit to the first assistant PCM frame.
- [ ] 12.2 Add a configurable launch-profile budget for first audio; deterministic voice QA fails when `first_audio_ms` exceeds that budget, while live QA records observed percentiles for phone and browser.
- [ ] 12.3 Add long-response audio QA: a fixture that produces multiple TTS segments must emit ordered audio, store one assistant PCM artifact, set `tts_segments`, and either finish spoken or degrade to visible text with `tts_error`.
- [ ] 12.4 Add continuous partial STT events for providers that support them, normalized as provisional transcript events with final transcript replacement and canonical final transcript storage.
- [ ] 12.5 Surface provider capability flags for partial STT and first-audio timing so clients and QA can distinguish "not supported" from "broken".
- [ ] 12.6 Verify phone and browser behavior: partial transcript appears while speaking, final transcript replaces it, first audio is audible within the configured budget on the launch profile, and a long response does not hang or silently truncate.

## 13. Stage C: Interruption Context And Cache-Friendly Turns

- [ ] 13.1 Persist interrupted, canceled, and dropped turns with partial transcript, partial assistant text, audio refs when available, provider events, failure/interruption phase, and incomplete status.
- [ ] 13.2 Include the partial turn summary in the next Moa-owned context pack so the user can interrupt on one device and resume on another without losing what was said.
- [ ] 13.3 Define per-turn context packs with stable refs for session, branch, turn, active thread, profile version, mode overlay, summaries, voice evidence, provider events, route decisions, and artifact refs.
- [ ] 13.4 Add a cache key or content hash to each context pack so retries, provider reconnects, replay QA, and agent routing reuse the same bounded evidence instead of rebuilding an unbounded prompt.
- [ ] 13.5 Verify with a barge-in/drop smoke that the next turn receives the partial context pack and that no stale assistant audio from the interrupted turn writes into the new turn.

## 14. Stage D: Profiles, Modes, Controls, And Demonstration

- [ ] 14.1 Add named mode overlays on the versioned agent profile for at least reliable voice, low-latency voice, text-only, demo, safe mode, and voice-first gestures. Each mode records its provider/profile deltas, latency budget, retention policy, and client interaction hints.
- [ ] 14.2 Make spoken and UI profile/mode changes reversible, visible, and scoped global or device-specific, with the response reporting whether the change applies immediately, next turn, or after reconnect.
- [ ] 14.3 Android: implement and QA the flag-gated voice-first orb gesture contract while preserving default drag, chat, and push-to-talk behavior when the flag is off.
- [ ] 14.4 Browser extension: implement and QA the mark gesture plus keyboard shortcut contract: Cmd+, or Ctrl+, opens text intent; Cmd+. or Ctrl+. toggles/commits voice on tap and uses push-to-talk while held.
- [ ] 14.5 Build a repeatable voice demonstration checklist and fixture set covering partial STT, first-audio latency, long-response playback, interruption/context preservation, profile/mode switching, voice-first gestures, browser shortcuts, and diagnosed failure.
- [ ] 14.6 Verification: Android build, browser verify/smoke, gateway check, deterministic voice demo smoke, one phone live voice turn, one browser live voice turn, and `openspec validate provider-agnostic-voice-agent-runtime --strict`.
