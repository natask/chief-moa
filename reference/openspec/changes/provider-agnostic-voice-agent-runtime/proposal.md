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
- Treat Gemini Live as the first high-quality live provider implementation, not
  the only architecture.

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
