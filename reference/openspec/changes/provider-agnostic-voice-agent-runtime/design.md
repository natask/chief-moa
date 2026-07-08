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
visible state change: "speak Amharic", "switch back to English", or "use
English and Amharic until I change it."

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
- Turn retained user/assistant audio into replayable QA evidence with expected
  transcript and response criteria.
- Let each user message fork or update async agent work without stopping
  already-running agents.
- Provide recovery controls when the agent behaves badly: safe mode, prompt
  rollback, tool disable, provider switch, cancel active runs, and text-only
  fallback.
- Make every voice failure diagnosable from self-hosted gateway records, not
  only from provider dashboards or ad hoc logs.
- Make long-response audio, first-audio latency, continuous partial STT,
  interruption context, profile/mode switching, voice-first gestures, browser
  shortcuts, and cache-friendly per-turn context explicit launch criteria.

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
- No provider-console-only observability as an acceptance path.
- No unbounded full-history prompt stuffing as the per-turn context strategy.

## Decisions

### Decision: Product Voice Success Is Measured At The Moa Boundary

The provider-agnostic runtime has a product contract independent of the selected
provider: the gateway records enough facts to answer "what failed?", "what did
the user say?", "what did Moa answer?", "why was it not spoken?", "what context
did the model see?", and "what should happen on retry?" without requiring the
operator to inspect a provider console.

Every voice turn can carry normalized phase diagnostics:

```text
capture -> transport -> STT -> context -> reasoning -> TTS -> playback -> store
```

When a phase is degraded or failed, the turn/provider events record the phase,
surface, session, branch, turn, profile version, provider ids, mode, timing,
artifact refs, and a user-facing summary. Provider-native events may be retained
for debugging, but Moa-owned normalized events are the self-hostable source of
truth. A "why did voice fail?" status path is a product requirement, not a log
grep.

Alternative considered: accept provider dashboards and server stdout as the
diagnostic story. Rejected because self-hosted deployments need local evidence,
and voice QA must compare capture, STT, reasoning, TTS, storage, and playback
without vendor-specific tools.

### Decision: First Audio And Long Replies Have Observable Budgets

The cascaded and native-live runtimes both report first-audio timing when the
provider can expose it. For cascaded streaming, `first_audio_ms` is measured
from turn commit or final STT to the first assistant PCM frame. Launch profiles
set the target budget; deterministic QA fails when the configured budget is
missed, and live QA records percentile evidence instead of treating latency as
an anecdote.

Long replies must be reliable before they are polished. A long spoken answer
streams or chunks ordered audio segments, records `tts_segments`, `tts_spoke`,
and `tts_error`, and degrades to visible text with a clear not-spoken state
instead of hanging, truncating silently, or letting a stale interrupted stream
write into the next turn. This aligns with the
`streaming-cascaded-voice` change, but the product contract applies to every
future provider mode.

Alternative considered: optimize only average response time. Rejected because
the user's pain point is the perceptible gap before any audio and the
reliability of longer spoken replies, not only total completion time.

### Decision: Continuous Partial STT Is A Runtime Feature, Not A UI Guess

Partial transcripts are provider-normalized voice runtime events. Android and
the browser display provisional text continuously while the user speaks, then
replace it with the final transcript that becomes the canonical turn input.
The gateway stores the final transcript with its source and may retain partial
events for diagnosis according to retention policy.

Providers that cannot stream partial STT must report that capability honestly.
The UI may still show capture/listening state, but it must not invent partial
text from local heuristics as if it came from the speech recognizer.

Alternative considered: show only final transcripts and treat partials as a
client enhancement. Rejected because continuous partial STT is part of the
voice-first product feel and is also a diagnostic signal for capture/STT
failures.

### Decision: Interruptions Preserve Context And Are Cache-Friendly

An interrupted, canceled, or dropped turn is not discarded. The gateway stores
whatever user transcript, assistant text/audio metadata, provider events, and
phase diagnostics exist, marks the turn incomplete when appropriate, and
includes a bounded summary of that partial turn in the next Moa-owned context
pack.

Each turn assembles a cache-friendly context pack from stable refs: session,
branch, turn, active thread, profile version, mode overlay, recent summaries,
voice evidence, provider events, route decisions, and relevant artifacts. The
pack records a cache key/content hash so retries, provider reconnects, agent
routing, and replay QA can reuse the same evidence instead of rebuilding an
unbounded transcript prompt.

Alternative considered: let each provider session keep the live conversation
state. Rejected because interruption recovery, cross-device resume, replay QA,
and provider swapping require Moa-owned context with stable identifiers.

### Decision: Profiles And Modes Are Versioned Product State

Modes such as reliable voice, low-latency voice, text-only, demo, safe mode, or
voice-first gestures are named overlays on the versioned agent profile. They
may adjust provider selection, response modality, language, tool policy,
latency budget, TTS cap, retention policy, and client interaction hints, but
they do not bypass the trust boundary: Android still owns phone UI/actions, the
browser extension still owns browser shortcuts/page actions, and the gateway
still owns provider credentials and storage.

Mode/profile changes are visible and reversible. A spoken change updates the
gateway profile, records a new version, reports whether the change applies
immediately/next turn/reconnect, and exposes the effective state to Android and
browser surfaces.

Alternative considered: keep modes in environment variables or provider
session configuration only. Rejected because the user needs to inspect, change,
demo, and recover behavior by voice across devices.

### Decision: Voice-First Controls Must Be Demonstrable On Both Surfaces

The phone orb and browser mark/keyboard shortcuts are part of the voice
runtime contract. Android owns orb gestures, visual state, microphone capture,
playback stop, permissions, and action approvals. The browser extension owns
the mark, shortcuts, offscreen microphone capture, queued playback, page
context, and local page actions. The gateway owns only the shared session,
profile, logs, context, and action proposals.

The launch demonstration must prove the same user-visible contract from phone
and browser: start voice, see partial STT, hear first audio within budget, play
a longer response, interrupt and preserve context, switch a mode/profile,
exercise voice-first gestures or shortcuts, and inspect a diagnosed failure.

Alternative considered: treat gestures and shortcuts as separate client polish.
Rejected because the voice product is not usable as a primary interface unless
the capture/commit controls are predictable and testable.

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

### Decision: Voice QA Replays Real Audio Through The Runtime

Voice verification uses replayable evidence records, not only text fixtures.
When retention is enabled, a turn can store or reference the user audio,
expected user transcript, assistant text, assistant audio/transcript, profile
version, provider selection, and pass/fail criteria. A smoke can replay the
audio through the gateway voice runtime, compare the observed transcript and
assistant response against the expected criteria, and record a verdict. This
lets failures show whether capture, STT, reasoning, TTS, or storage regressed.

Alternative considered: test only the transcript HTTP endpoint. Rejected because
it cannot prove the real audio path, provider transcription, assistant audio, or
turn storage behavior.

### Decision: User Turns Are Non-Interrupting Agent Fork Opportunities

Every voice or chat turn is first stored as a canonical user event. The gateway
agent manager then decides whether that event should create a new async
`agent_run`, attach to one or more active runs as follow-up evidence, route to a
specific run, or be dismissed as irrelevant. Launching a new fork must not
cancel already-active work unless the user explicitly asks to cancel it. This
preserves the user's spoken flow: they can interrupt the conversation surface
and start another line of work while prior agents keep running.

Alternative considered: make each new user utterance replace or cancel the
previous agent task. Rejected because it loses long-running delegated work and
does not match the desired "many active threads" interaction model.

### Decision: Language Is Explicit Runtime State

The agent profile includes:

```text
language.mode = explicit
language.primary = en-US | am-ET
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

The profile includes assistant name/identity, system prompt, required voice
style, language settings, model/reasoning provider, STT provider, TTS provider,
allowed tools, approval policy, autonomy level, memory policy, active workspace,
and recovery mode. Spoken identity changes such as "your name is X", "you are
X", and "call yourself X" are profile-control updates, not chat turns; the
gateway confirms them tersely and regenerates provider prompts from the durable
profile state.

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
- Forked agent runs can create noise -> Require a gateway manager decision and
  visible active-run status so irrelevant forks can self-dismiss and the user can
  inspect what is still running.

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
6. Add replayable audio QA fixtures and a first smoke that exercises the real
   audio path end to end.
7. Add non-interrupting forked agent routing so a turn can launch new async work
   while active runs continue receiving relevant context.
8. Add safe mode: cancel/stop controls, tool disable, provider fallback, and
   known-good profile rollback.
9. Add modular provider implementations after the contracts are testable with
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
- What is the first judge for response correctness: deterministic transcript
  matching, a gateway-local LLM judge, or both?
- Should every user turn fan out to active runs by default, or should the
  manager explicitly route only to relevant runs?
