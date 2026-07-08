## Why

Moa's voice loop should not depend on Gemini Live as the product architecture.
Gemini Live is useful for realtime speech, endpointing, interruption, and
native audio, but Moa needs provider flexibility, explicit user-controlled
language state, durable local history, and recoverable agent configuration that
the user can inspect and change by voice.

## What Changes

- Define a provider-agnostic voice runtime that can run either a bundled live
  provider package or separate STT, reasoning, and TTS providers behind the
  gateway.
- Make the overlay a persistent continuous conversation surface with visible
  state, transcript, assistant output, interrupt handling, and audio-reactive
  orb feedback.
- Add an explicit user-selected language mode. Moa SHALL NOT silently switch
  spoken language as the normal product behavior; language changes are durable
  state transitions requested by the user or configured in settings.
- Add a runtime-editable agent profile for system prompt, voice style, model
  provider, speech providers, tool policy, autonomy level, memory policy, and
  safe-mode behavior.
- Make Moa-owned session history the canonical record for transcripts, audio,
  assistant messages, provider events, prompt/profile versions, tool proposals,
  active runs, and recovery state.
- Add replayable voice evidence so captured/user-provided audio, transcripts,
  assistant text/audio, and expected criteria can become automated QA fixtures.
- Treat each user turn as a possible non-interrupting agent fork: a new message
  can launch a new run, route to existing active runs, or be dismissed by the
  gateway agent manager without stopping prior work.
- Add a product voice contract for diagnosable failures, self-hostable logs,
  long-response audio reliability, below-perceived-wait first audio,
  continuous partial STT, interrupt context preservation, configurable
  profiles/modes, voice-first gestures, browser shortcuts, repeatable demos,
  and cache-friendly per-turn context packs.
- Treat Gemini Live as the first high-quality live provider implementation, not
  the only architecture.

## Product Success Criteria

The change is not complete until the user can prove the voice loop from the
phone and browser without provider-console guesswork:

- A failed or degraded voice turn names the most likely failing phase: capture,
  transport, STT, reasoning, TTS, playback, storage, context assembly, or
  comparison.
- The self-hosted gateway stores the normalized logs, provider events, turn
  records, context-pack refs, audio refs, and replay verdicts required to debug
  that failure.
- Long replies stream or otherwise deliver audio reliably, record
  `tts_segments`, `tts_spoke`, and `tts_error`, and fall back to visible text
  instead of ending silently.
- First assistant audio is measured as `first_audio_ms` and checked against a
  configurable launch-profile budget intended to keep delay below the user's
  perceived waiting threshold.
- Speaking surfaces show continuous partial STT before final transcript
  replacement, while the final stored transcript remains canonical.
- Interrupting, canceling, or dropping a turn preserves partial user and
  assistant context for the next turn.
- Profile and mode changes are versioned gateway state that Android and browser
  surfaces can display and use, not hidden provider/session state.
- A repeatable voice demonstration covers partial STT, first audio, long
  response playback, interruption, profile/mode switching, voice-first gestures,
  browser shortcuts, and failure diagnosis.

## Capabilities

### New Capabilities

- `voice-provider-registry`: Gateway-owned provider registry for bundled live
  providers and modular STT, reasoning, and TTS providers.
- `continuous-voice-session-runtime`: Persistent overlay voice sessions with
  realtime state, transcript, assistant audio, interruption, and audio-reactive
  orb signals.
- `agent-profile-control-plane`: Runtime-editable, versioned agent profile for
  prompt, behavior, language, providers, tools, approvals, and recovery.
- `moa-owned-conversation-memory`: Canonical Moa storage for voice/chat history,
  provider events, audio artifacts, summaries, and profile versions used by each
  turn.
- `provider-independent-language-state`: Explicit language selection and visible
  language state that does not depend on automatic provider language switching.
- `voice-evidence-replay-qa`: Replayable voice fixtures that compare input
  audio transcription, assistant response text, and assistant audio/transcript
  against expected criteria.
- `forked-agent-session-routing`: User turns can fork independent agent runs
  while active runs continue and receive later relevant turns as evidence.
- `voice-product-diagnostics`: Self-hostable voice failure diagnosis based on
  normalized turn/provider events, phase labels, context-pack refs, and replay
  verdicts.
- `voice-first-control-surfaces`: Flag-gated Android orb gestures and browser
  mark/keyboard shortcuts that make voice capture the primary interaction while
  preserving existing drag, resize, and chat controls.
- `cache-friendly-turn-context`: Bounded per-turn context packs keyed by stable
  session, branch, turn, profile, summary, artifact, and route-decision refs so
  retries, provider restarts, and agent routing reuse the same evidence.

### Modified Capabilities

- None in mainline specs yet. This change builds on the active
  `define-android-core-product-map` change and should be reconciled into the
  main product specs when that map is archived.

## Impact

- Android app: overlay state machine, orb visualization, transcript rendering,
  settings/control-center surfaces, and voice command routing in
  `android_app/app/src/main/java/ai/moa/assistant/*`.
- Gateway: voice session protocol, provider selection/configuration, canonical
  session storage, profile APIs, provider event logging, and recovery endpoints
  in `gateway/server.js` and `gateway/lib/*`.
- Data model: session, branch, turn, audio artifact, provider event, profile
  version, voice evidence fixture, tool policy, run, fork linkage, approval, and
  receipt records must be queryable by the gateway and agent harnesses.
- Verification: OpenSpec validation, gateway checks/smokes, Android build,
  provider-swap smoke tests, audio replay QA, forked-run routing smoke tests,
  and real-phone QA for continuous overlay voice, explicit language changes,
  interruption, transcript visibility, and recovery.
