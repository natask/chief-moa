## Context

The cascaded voice pipeline is the live production path (`MODEL_PROVIDER=vertex`
cascaded; Gemini/Vertex Live is a switchable legacy mode). Both LLM calls run
`stream: false`, and `synthesizeSpeech` emits one PCM blob after the entire
reply text exists. A user therefore hears nothing until reasoning finishes AND
the whole reply has been synthesized. The wire protocol was never the
bottleneck: Gemini Live and the loopback QA provider already stream many PCM
frames per turn through the same `assistant_audio_start` / binary-frame /
`assistant_audio_done` envelope, and both Android and the browser already play
an arbitrary number of frames. The bottleneck is entirely inside the cascaded
provider's non-streaming LLM call and single blocking synthesize call.

This design was produced against a 2026-07-06 voice-stack audit and spot-
checked line references in `server.js` and `voice-providers.js`; the load-
bearing claims (single-frame emit, non-streaming LLM calls, hardcoded provider
instantiation) held. The 2026-07-06 voice crash-loop postmortem is a second
input: it established that a voice-turn fault, and specifically a stale
audio-stream write across a barge-in, must never take the process or session
down. A long-lived, chunked stream reopens exactly that race (more writes,
more chances for a barge-in to land mid-emission), so the interruption guard
in this design is not optional hardening — it is a hard precondition for
shipping streaming at all.

## Goals / Non-Goals

**Goals:**

- Cut time-to-first-audible-frame on cascaded turns by starting hosted TTS on
  the first speakable sentence instead of waiting for the full reply.
- Keep the wire protocol's event set unchanged; only the frame count and the
  text/audio ordering for multi-chunk replies change, both already tolerated
  by both clients.
- Keep every existing non-streaming caller (`VOICE_STREAMING=0`, browser-
  evidence speak caps, profile-control confirmations) byte-identical.
- Make the provider internals swappable behind a small formal seam
  (`voice-stages.js`) without changing the outer `processTurn(turn, hooks)`
  contract any caller depends on.
- Ship with a fast, operator-free rollback (in-process circuit breaker) in
  the same commit as the feature, because the deploy gate's restore-check does
  not exercise a real voice turn.
- Store no new turn-record shape; every addition is optional/additive so
  rollback needs no data migration.

**Non-Goals:**

- No change to STT: Chirp 3 recognition stays whole-file/non-streaming in
  this phase (section 2 of the source design explicitly scopes streaming to
  the LLM and TTS legs, not STT).
- No change to the non-streaming reasoning function `callModelToolLoop`; it
  stays the `VOICE_STREAMING=0` and non-voice-caller path, untouched.
- No raise to the shared `VOICE_TTS_MAX_CHARS` ceiling; a separate streaming-
  only cap is added instead.
- No decision here about LiveKit's transport; that stays the separate
  flag-gated `livekit-voice-transport` prototype. This change only makes the
  LiveKit worker's `/v1/internal/voice/reason` hook benefit incidentally,
  since it calls the same `runCascadedVoiceReasoning` path.
- No change to Android/browser wire-level playback code; their lanes verify
  against this shipped behavior and hardened any latent per-frame issues
  found in that QA, but add no new protocol surface.

## Decisions

### Decision: keep the envelope, stream N frames instead of adding events

No new WS event types. `assistant_audio_start` -> N binary PCM16 frames ->
`assistant_audio_done` -> `turn_done`, exactly as today. The cascaded provider
changes from calling `hooks.sendAudio(pcm)` once per turn to once per
synthesized chunk. `assistant_audio_start` gains an additive `streaming: true`
flag when the pipelined path is active; `turn_done` gains additive
`first_audio_ms` and `tts_segments`. Old clients ignore fields they do not
recognize and already loop on binary frames arbitrarily, so this is
wire-compatible with zero client changes on the non-interrupted path.

Alternative considered: a new set of streaming-specific WS events (e.g.
`assistant_audio_chunk` with sequence numbers). Rejected: it would require
coordinated client changes before the feature could ship at all, defeating
the goal of a same-commit, default-on gateway change.

Ordering consequence, accepted as-is: for any reply longer than one chunk,
`assistant_text` (full reply text, sent once the LLM stream ends) now arrives
AFTER the first binary frame, inverting today's order. Both clients handle
`assistant_text` and `assistant_audio_start` independently in either order, so
this is safe; a one-chunk reply may still deliver text first.

### Decision: an interruption guard ships in the same commit as the multi-frame emit

Today the single TTS emit happens inside `processTurn`, and the
`this.turn !== turn` staleness check only runs after `processTurn` returns. A
long-lived chunked stream needs the check evaluated continuously, not once,
or a barge-in mid-emission interleaves a dead turn's audio into the new turn
and — on the shipped Android client — flips the global `assistantAudioOpen`
window shut on the wrong turn. Three parts, all required:

1. A turn-identity + non-terminal-status check at hook entry
   (`sendAudio`, `onAssistantAudioStart`, `onAssistantAudioDone`), throwing a
   named `TurnSupersededError` on failure; an additive `isTurnActive()` hook
   exposes the same boolean so the TTS pipeline can poll cheaply between
   chunks.
2. A re-check immediately before the socket write, because `sendAudio` awaits
   a potentially slow `writeAssistantAudio` (which can await a stream
   `drain`) before the actual `sendWs`; a barge-in can complete during that
   await, so the entry check alone has a TOCTOU hole.
3. A `writeAssistantAudio` null/closed-latch guard: today it lazily
   re-creates (`flags:"w"`, truncating) the assistant PCM stream when it is
   null. Under streaming plus barge-in this either reopens and truncates a
   finalized file on a closed turn, or throws on the null between check and
   write. Fix: a `turn.assistantAudioClosed` latch, set by
   `closeAssistantAudioStream`, makes a late write return early (drop the
   chunk, no throw, no re-create).

`TurnSupersededError` is caught by class inside the streaming pipeline itself
and aborted silently (no `tts_error`, no client event); it must never escape
into the reasoner's own catch (which would mislabel it a reasoning failure)
or the outer turn-timeout wrapper, and must never take the process down. This
mirrors the exact rule the 2026-07-06 crash-loop postmortem established for
`writeTurnAudio`, now applied to `writeAssistantAudio`.

Alternative considered: only add the entry-level check and treat the TOCTOU
window as negligible. Rejected: the window includes an awaited stream
`drain`, which is not negligible under backpressure, and the failure mode
(corrupting the NEXT turn's audio-open state on the shipped Android client)
is worse than a dropped frame.

### Decision: LLM streaming keeps tool calls intact and never drops tool-round-only text

A new `callModelToolLoopStreaming` runs beside the untouched
`callModelToolLoop`, for both the live Vertex path
(`streamGenerateContent?alt=sse`) and the OpenAI-compatible path
(`stream: true` SSE), because a profile can swap `reasoning_provider` at
runtime. Per round: hold text deltas until it is clear the round has no tool
call; the moment a tool-call delta arrives, stop forwarding that round's text
live but keep it buffered, run the tools, and continue. On `finish_reason:
"tool_calls"`, execute handlers exactly as the non-streaming loop does and
loop into the next round.

Tool-round text must not be discarded: today `lastText` is taken from ANY
round including tool rounds, so a turn whose only prose rides the tool round
(e.g. "Switching to Amharic, done." plus `update_agent_profile`) would
silently speak zero audio if that text were dropped during streaming. Rule:
buffer tool-round text; a later round with non-empty final text overwrites
the buffer; if the loop ends and the buffer IS the returned text, flush it to
the delta callback before returning. Streamed speech therefore always equals
the returned `speak`, including tool-round-only replies.

Safety valve: any SSE transport or parse error inside a round falls back to
one non-streaming call for that round, so a provider that rejects streaming
degrades to today's behavior instead of failing the turn.

Alternative considered: only stream when the model's first round has no
tools available. Rejected: every cascaded turn offers profile/agent-run tools
with `tool_choice:auto`, so this would make streaming inapplicable to nearly
every real turn; buffering tool-round text is a small, containable rule
instead.

### Decision: a pure, timer-free chunker owns sentence/clause boundaries

`gateway/lib/voice-chunker.js` is pure functions with no I/O and no internal
timers, so it is unit-testable with plain asserts and the flush timer lives in
the caller. Priority order: sentence enders (Latin `. ! ? …` plus Ethiopic
`። ፧ ፨`, Arabic `؟`, CJK `。！？`) with a following-whitespace/quote
requirement; clause enders (`, ; :` plus Ethiopic `፣ ፤ ፥`, Arabic `،`) once
the buffer is already past a minimum length; a hard split past a maximum
length at the last whitespace. A first-chunk policy tightens thresholds so the
very first sentence leaves for TTS as fast as possible. Latin abbreviation/
decimal/ellipsis/lowercase-continuation guards prevent false sentence breaks;
Ethiopic needs no such guard because `።` is unambiguous and Amharic does not
overload `.` as a sentence ender, so mixed-script text is handled by the union
of both rule sets. A bracketed `[tag]` span (expressive-speech directive) is
always atomic and never starts a chunk without its prose.

Alternative considered: a single global regex boundary matcher with no
first-chunk/hard-split tiers. Rejected: it would either wait for full
sentences (losing the first-chunk-fastest latency win) or risk an unbounded
buffer on a run-on reply with no punctuation.

### Decision: pipelined TTS with bounded concurrency and strictly ordered emission

`streamSynthesizedReply` reuses the existing per-call `synthesizeSpeech` /
`synthesizeCloudTts` unchanged (already stateless per call). At most 2 synth
requests run concurrently (`VOICE_TTS_CONCURRENCY`, default 2): chunk n+1
synthesizes while chunk n's PCM is being emitted. Emission is strictly
ordered via a promise chain regardless of synth completion order. Language,
voice, and the style prompt are pinned once at stream start (see the gate-
hoisting decision below) and reused for every chunk in the turn.

A failed chunk (HTTP error, timeout, empty audio) sets `ttsError`, aborts all
pending/in-flight synthesis for the turn via a shared `AbortController`, and
stops further audio — but the turn continues: `assistant_text` still delivers
the full reply (text delivery never depends on TTS), `assistant_audio_done`
still fires if audio had started, and the result carries `tts_spoke` (true if
at least one chunk played) and `tts_error`, feeding the next turn's honesty
context exactly as today. Nothing in the pipeline may throw out of
`processTurn` for a synthesis fault.

Barge-in cancellation reuses the interruption guard: the pipeline checks
`hooks.isTurnActive()` before launching each synth and before each emission,
and aborts in-flight fetches via the same `AbortController` when a
`TurnSupersededError` is thrown. Cancellation is silent (no `tts_error`, no
events for the dead turn); waste is bounded to at most 2 in-flight requests,
both aborted.

Alternative considered: unbounded concurrency (synthesize every chunk as soon
as the chunker produces it). Rejected: an ordinary multi-sentence reply could
fire many concurrent hosted-TTS requests, with no latency benefit past 2
in-flight (emission is already the bottleneck, not synth throughput) and a
real cost/quota risk.

### Decision: gate-hoisting — modality and TTS-language resolve before the LLM stream starts

Today `processTurn` gates TTS on `modality` and `canSynthesize(language)` only
AFTER the reasoner returns. Streaming needs chunk 1 to synthesize before that
point exists, so both gates are resolved before the stream starts: modality
from `replyModality()` (already read at `processTurn` start) and TTS language
pinned once from `replyLanguage()`. `on_speak_delta` drives synthesis only
when both gates pass; otherwise the pipeline is inert and the turn behaves
exactly as today (`response_modality:"text"` stays silent; an
unsynthesizable language stays text-only with no per-chunk network calls that
would fail). A mid-turn `update_agent_profile` language change takes effect
next turn, not mid-stream. If the reasoner's final `reasoning.language`
differs from the pinned language after audio already played, the record notes
`tts_language_mismatch`, feeding the next turn's honesty context; the
reasoner's own `reasoning.language` stays authoritative in the stored record.

Alternative considered: re-check the gates on every chunk against the live
profile. Rejected: it would let a single turn's audio silently switch voice/
language mid-reply, which is worse UX than pinning once and reporting the
mismatch.

### Decision: `VOICE_TTS_MAX_CHARS` stays the ceiling; streaming gets its own cap

`VOICE_TTS_MAX_CHARS` (280) is a module constant that keeps governing every
non-streaming consumer unchanged: the browser-evidence speak caps, the
profile default, and the `VOICE_STREAMING=0` path. Raising it would silently
grow those single blocking synthesize calls, so it is not touched. A new env,
`VOICE_STREAM_MAX_CHARS` (default 1600), is the streaming sanitizer's own cap
and applies only inside the chunked pipeline; the profile field
`voice_max_chars` still overrides both, in the same precedence order as
today. Per-chunk synth input stays bounded by the chunker's own `maxChars`
(220), far under the hosted TTS request-size cap, so there is no per-request
size risk regardless of the overall streaming cap.

The streaming sanitizer's guarantee is a prefix property, not byte equality:
because `capSpeakText` compacts whitespace globally and `truncate` can cut
mid-word, the streamed cumulative text and the final stored capped `speak`
can land on slightly different characters near the limit. Streamed speech is
guaranteed to be a prefix of the stored capped text, identical up to at most
the final clause; audio never contains text absent from the record.

Alternative considered: raise the shared `VOICE_TTS_MAX_CHARS` instead of
adding a second env. Rejected: it is read by non-streaming callers that have
no latency reason to grow, only a cost/runaway reason to stay bounded.

### Decision: formalize the provider seam without touching the transport contract

A new `gateway/lib/voice-stages.js` defines three small duck-typed
interfaces — `SttProvider`, `Reasoner`, `TtsProvider` — each with an `id` and
a `capabilities` map. Existing bodies move out of the monolithic provider
class: `transcribePcmFile` becomes the `chirp` SttProvider, the injected
reasoner closure becomes the `gateway` Reasoner, and
`synthesizeSpeech`/`synthesizeCloudTts` become the `cloud-tts` and
`gemini-tts` TtsProviders, sharing auth/token caching through one `GcpAuth`
helper. `VOICE_PROVIDER_REGISTRY` entries gain a `create(options)` factory,
and `createVoiceProvider` resolves stages through the registry instead of an
if/else chain; the native-live branches (`loopback`, `gemini-live`,
`vertex-live`) become registry factories too, so adding a provider is adding
one registry entry. New capability flags `streaming_tts` and
`streaming_reasoning` join the existing `PROVIDER_CAPABILITY_FLAGS` and flow
automatically into `/health`, so `moa-voice-qa` and clients can see whether
the live gateway is actually streaming.

The outer transport contract does not move: `processTurn(turn, hooks)`,
`status()`, and `synthesizeAssistantSpeech` keep their exact signatures, so
the session server, Android, browser, and the LiveKit worker's internal voice
hooks never see the stage seam. No raw provider keys change custodian; the
shared `GcpAuth` helper still lives inside the gateway process only.

Alternative considered: leave provider bodies inline and only add the
streaming behavior. Rejected: the streaming LLM/TTS logic already needs a
place to live that is not entangled with the STT/transcription code path;
formalizing the seam now avoids a second refactor once the modular
STT/LLM/TTS combinations from the provider-agnostic-voice-agent-runtime
change land.

### Decision: one env kill switch, one in-process circuit breaker

`VOICE_STREAMING` (unset or `1` = on, `0` = off) is read per turn from
`process.env` inside the turn path, not cached as a module-load constant, so
an in-process override can flip it without touching module state. It is
still an operational rollback path only: changing `gateway.env` on the
droplet needs a container recreate (~30s, drops open voice sockets, which are
client-retriable), so it is not a fast circuit breaker by itself.

The fast path is a streaming circuit breaker: if the streaming path faults 3
times in one process — an error escaping the pipeline's guard, a fallback
that itself fails, or a `TurnSupersededError` reaching the wrong layer — the
session server latches streaming off for all later turns in that process
(the per-turn flag read consults the latch first), logs
`voice_streaming_tripped` once, and every later turn runs non-streaming. This
is required because the deploy gate's `restore-check.sh` never drives a real
voice turn, so a fault that only reproduces on a spoken turn would otherwise
pass the gate and the droplet's auto-update timer would keep re-promoting a
bad ref. The breaker plus the `writeAssistantAudio` null-guard remove the
known process-killing class from the 2026-07-06 postmortem; anything novel
degrades to non-streaming instead of crash-looping.

Default is ON, with a mandatory caveat: the shipped Android APK and packaged
browser extension currently exercise the cascaded path only in its
single-frame form in production, so their multi-frame handling — though
already exercised by the Gemini Live and loopback paths in source — is
unproven for these exact deployed artifacts. That is why rollout step 2 (live
QA on both real clients, immediately after promotion) is mandatory, not
optional observation.

Alternative considered: default OFF behind the env flag, flip on after a
observation period. Rejected: the source-level evidence that both clients
already tolerate N frames is strong enough, combined with the same-commit
interruption guard and circuit breaker, to default on and verify with
mandatory live QA rather than a slower staged rollout.

## Risks / Trade-offs

- Barge-in races are the highest-risk surface introduced by this change ->
  mitigated by the three-part interruption guard landing in the same commit,
  not as a follow-up, and by dedicated smoke coverage (interruption,
  null-stream guard).
- The deploy gate cannot exercise a real voice turn, so some faults will only
  surface in production -> mitigated by the in-process circuit breaker
  (self-healing without an operator) and the mandatory post-promote live QA
  on both real clients.
- Tool-round-only replies could go silent under naive streaming -> mitigated
  by the buffer-and-flush rule; covered by a dedicated smoke case.
- The two caps (`VOICE_TTS_MAX_CHARS` for non-streaming,
  `VOICE_STREAM_MAX_CHARS` for streaming) can drift out of sync in an
  operator's mental model -> mitigated by keeping the non-streaming cap
  completely untouched and documenting the split explicitly here and in
  `ARCHITECTURE.md`.
- Streaming SSE parsing (Vertex and OpenAI-compatible shapes differ in how
  function-call arguments can arrive split across chunks) is genuinely fiddly
  -> mitigated by the per-round safety valve that falls back to one
  non-streaming call on any parse/transport error, and by dedicated streaming
  tool-loop smokes for both shapes.
- Rollback is a container recreate, not instantaneous -> open voice sockets
  drop but are client-retriable; this is stated as promotion-gate evidence,
  not implied as zero-interruption.

## Migration Plan

1. Land `voice-chunker.js` and its pure unit tests first; it has no
   dependency on the streaming LLM or TTS work and is independently
   verifiable.
2. Land the interruption guard (hook re-check, `writeAssistantAudio`
   null/closed latch) as its own reviewable unit inside the gateway-streaming
   lane, since it is a hard precondition for everything after it.
3. Land `callModelToolLoopStreaming` for both reasoning providers with the
   tool-round-text buffering rule and the per-round safety valve.
4. Land `streamSynthesizedReply` wired to the chunker and the streaming
   reasoner, gated by the hoisted modality/language checks, with the
   streaming circuit breaker active from the same commit.
5. Land the `voice-stages.js` provider seam and capability-flag exposure on
   `/health` (can land alongside or immediately after step 4; it does not
   block the streaming behavior itself).
6. Merge the gateway-streaming lane to master and push; the existing
   `Deploy VPS gateway` workflow and droplet auto-update timer promote it
   behind the unchanged backup/restore-check gate.
7. Run the mandatory live QA (phone AND browser) immediately after promotion,
   per the rollout order in `proposal.md`.
8. Android-compat and browser-compat lanes verify against the promoted
   gateway and ship their own hardening/OTA/extension-reload artifacts on
   their own schedule; neither blocks the gateway promotion.
9. The LiveKit-language lane (worker reads `input_languages` from the profile)
   ships independently; it shares no files with this change and is not gated
   on it.

## Open Questions

- Should the streaming circuit breaker's trip count (3) and its "for the rest
  of the process" scope be tunable, or should a tripped process eventually
  retry streaming after a cooldown? Left as a fixed per-process latch for
  this change; revisit if the droplet sees frequent single-process restarts
  masking a real recurring fault.
- Should `first_audio_ms` and `tts_segments` feed an automated regression
  alert (e.g. flag if median `first_audio_ms` regresses toward the
  non-streaming baseline) rather than only being read ad hoc by
  `moa-voice-qa`? Left for a follow-up once enough live-traffic samples exist.
- Should STT itself move to streaming recognition in a later phase, now that
  the LLM and TTS legs stream? Left out of scope here; Chirp 3 whole-file
  recognition is unchanged by this change.
