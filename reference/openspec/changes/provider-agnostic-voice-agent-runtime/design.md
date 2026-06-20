## Context

Moa currently has a working Android overlay, gateway voice sessions, persisted
PCM/audio metadata, async agent runs, OTA delivery, and Gemini Live as a
gateway-owned realtime voice provider. That proves feasibility, but the product
shape is still too close to "whatever the current realtime provider does."

The desired product is a phone-native assistant that can keep a continuous
conversation open, show state and transcript, interrupt playback, start or
continue agent work, and let the user change the assistant's behavior by voice.
The user also needs explicit language control. Automatic language switching can
be an optional demo/provider feature, but the normal Moa behavior must be a
visible state change: "speak Amharic", "switch back to English", "answer in
Spanish until I change it."

The core constraint remains unchanged: Android owns UI, permissions, approvals,
and phone-local execution. The gateway owns provider credentials, routing,
conversation storage, agent-run storage, and harness execution.

## Goals / Non-Goals

**Goals:**

- Make Gemini Live one provider package, not the architecture.
- Support both bundled live providers and modular STT + reasoning + TTS
  providers behind one stable Android/gateway protocol.
- Keep a persistent overlay voice session alive until the user stops it, the
  overlay is dismissed, permissions are revoked, or a recoverable error occurs.
- Make language an explicit, durable, user-visible state.
- Let the user inspect and change the agent profile by voice and from the full
  app, including prompt, voice style, providers, language, tools, approvals, and
  autonomy level.
- Store Moa-owned transcripts, audio artifacts, provider events, prompt/profile
  versions, agent runs, and tool receipts as canonical history.
- Provide recovery controls when the agent behaves badly: safe mode, prompt
  rollback, tool disable, provider switch, cancel active runs, and text-only
  fallback.

**Non-Goals:**

- No direct provider credentials in Android.
- No provider-specific Android protocols.
- No automatic language switching as the default Moa UX.
- No hidden execution of model output as phone commands.
- No requirement that every provider support native duplex audio. Providers can
  expose a lower capability tier through modular STT/reasoning/TTS.
- No full database migration in the first implementation slice unless a ticket
  explicitly chooses it; JSON/JSONL can remain an early backing store if the API
  contract is correct.

## Decisions

### Decision: Voice Runtime Has Two Provider Modes

The gateway voice runtime exposes one Android protocol and supports two internal
provider modes:

```text
native_live
  provider owns realtime speech recognition, turn detection, interruption,
  reasoning, and assistant audio

modular
  STT provider -> reasoning provider -> TTS provider
  Moa runtime owns turn lifecycle, endpointing policy, interruption, and audio
  playback coordination
```

Gemini Live starts as the first `native_live` implementation. Whisper/Chirp plus
Gemini/Claude/OpenAI/local reasoning plus Android TTS/Piper/hosted TTS can be
implemented as `modular` combinations later.

Alternative considered: standardize only on Gemini Live. Rejected because it
would make Moa's language, memory, prompt control, and interruption semantics
depend on one provider's session behavior.

Alternative considered: standardize only on modular STT/LLM/TTS. Rejected
because native live providers provide lower-latency endpointing, interruption,
and assistant audio that are worth using when available.

### Decision: Moa Owns Canonical State, Providers Own Temporary Sessions

Provider sessions are treated as transport/runtime contexts. Moa stores the
canonical records: session, branch, turn, transcript, assistant output, audio
files, provider events, profile version, tool proposals, agent runs, approvals,
and receipts. When a provider connection restarts or the user switches
providers, the gateway reconstructs useful context from Moa-owned summaries and
profile state.

Alternative considered: rely on Gemini Live remote session history. Rejected
because provider sessions are not a durable product database, are difficult for
other agents to query, and do not solve cross-provider migration.

### Decision: Language Is Explicit Runtime State

The agent profile includes:

```text
language.mode = explicit
language.primary = en-US | am-ET | es-ES | ...
language.output = same_as_input | primary_only | configured_value
language.auto_switch = false by default
```

Voice commands such as "switch to Amharic" update the profile state and produce
a visible overlay/full-app state change. The provider prompt/setup is regenerated
from this state. Automatic language detection can be used internally for
transcription quality, but it must not silently change the assistant's durable
spoken/output language unless the profile explicitly allows it.

Alternative considered: let the model infer language every turn. Rejected
because it creates unpredictable UX and makes it hard for the user to know what
state the assistant is in.

### Decision: Agent Profile Is Versioned And Editable At Runtime

The gateway exposes profile APIs and voice intents to inspect, update, and roll
back agent configuration. Every turn records the profile version used. Profile
changes can update provider setup for future turns, and native live providers
that support mid-session instruction updates can receive changes immediately.
Providers that do not support this are restarted or updated on the next turn.

The profile includes system prompt, required voice style, language settings,
model/reasoning provider, STT provider, TTS provider, allowed tools, approval
policy, autonomy level, memory policy, active workspace, and recovery mode.

Alternative considered: keep the prompt as an environment variable only.
Rejected because the user needs to steer behavior while speaking and recover
without editing server files.

### Decision: Overlay Shows Runtime State, Full App Shows Control

The overlay remains small but visible: orb state, audio level, language label,
partial/final transcript, assistant output, active run count, and stop/mute
controls. The full Android app owns profile editing, provider selection,
history, run inspection, approvals, and rollback.

Alternative considered: put every setting into the overlay. Rejected because it
would make the always-on surface too heavy.

### Decision: Recovery Is A Product Primitive

The control plane has a safe mode that can be triggered by voice or UI. Safe
mode cancels active non-essential runs, disables tool execution, reverts to a
known-good profile, switches to text-only or baseline speech providers if
needed, and records why recovery happened.

Alternative considered: rely on app restart or gateway restart. Rejected
because the user needs an immediate escape hatch if the assistant's prompt,
tools, or provider state breaks during a live conversation.

## Risks / Trade-offs

- Provider capability mismatch -> The registry must expose capability flags such
  as `duplex_audio`, `barge_in`, `server_vad`, `mid_session_profile_update`,
  `partial_transcripts`, `voice_output`, and `language_hints`.
- More architecture before visible UI polish -> First tickets must produce
  visible progress: language state in overlay, profile endpoint, and provider
  registry health.
- Native live providers can still hide details -> Log normalized provider
  events and keep Moa-owned transcript/audio/history as the source of truth.
- Mid-session profile edits may not apply uniformly -> Record whether a change
  applied immediately, next turn, or after provider restart.
- Explicit language state can reduce convenience for multilingual users ->
  Add an opt-in `auto_switch` setting later, but keep it off by default.
- Persistent audio storage has privacy risk -> Store locally/gateway-side under
  session records with retention settings and visible controls before adding
  broad sync/export behavior.

## Migration Plan

1. Add provider registry contracts and health output without changing Android's
   WebSocket protocol.
2. Add `agent_profile` records with default values derived from current gateway
   environment settings and `DEFAULT_SYSTEM_PROMPT`.
3. Add explicit language state to the profile and display the selected language
   in Android overlay/full-app settings.
4. Normalize voice session events so native live and modular providers emit the
   same transcript, assistant-audio, interruption, completion, and error events.
5. Add profile update and rollback endpoints, then route spoken control turns
   such as "change your system prompt" and "switch to Amharic" to profile
   changes instead of normal chat.
6. Add safe mode: cancel/stop controls, tool disable, provider fallback, and
   known-good profile rollback.
7. Add modular provider implementations after the contracts are testable with
   the existing Gemini Live and loopback providers.

## Open Questions

- Which modular STT provider should be first: local Whisper, Google Chirp, or a
  hosted OpenAI-compatible STT path?
- Which TTS fallback should be first beyond Android TTS: Piper/local, Gemini
  audio, OpenAI-compatible TTS, or another hosted provider?
- Should profile storage remain JSON/JSONL for one more slice or move directly
  into the planned Postgres store?
- How much raw audio retention should be on by default, and what retention UI is
  required before broader user testing?
