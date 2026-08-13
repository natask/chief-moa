## Why

The cascaded voice pipeline (Chirp 3 STT -> gateway LLM -> hosted TTS) today
runs one blocking TTS call over the full reply text and emits exactly one PCM
frame per turn (`stream: false` on both LLM calls; single blob emit in
`synthesizeSpeech`). Playback cannot start until the whole reply has been
reasoned AND the whole reply has been synthesized. Both clients and the wire
protocol already tolerate many PCM frames per turn: Gemini Live and the
loopback QA provider stream today. The cascaded provider is the only
single-frame producer. This change makes cascaded turns stream: the LLM
streams text deltas, a sentence/clause chunker slices those deltas into
speakable pieces, and pipelined hosted TTS synthesizes and emits each piece as
its own ordered PCM frame, so audible playback starts while the reply is still
being reasoned instead of after it completes.

Speed is the goal; correctness and crash-safety are the constraints. The
2026-07-06 voice crash-loop postmortem established that a voice-turn fault
must never take the process or session down, and a barge-in must never
corrupt the next turn. This change's interruption guard and stream-write
null-guard exist to keep that guarantee under a long-lived, chunked stream
instead of a single blocking call.

## Decision facts (settled)

- No new WS event types. The existing envelope (`assistant_audio_start`, N
  binary PCM frames, `assistant_audio_done`, `turn_done`) carries the stream.
  Both clients already play an arbitrary number of frames per turn (source:
  Android's `assistantAudioOpen` window and streaming `AudioTrack`; the
  browser's accumulating `playbackTime` cursor), so this can default ON with
  zero client changes on the non-interrupted path.
- Ordering inverts for any multi-chunk reply: `assistant_text` (the full reply
  text) now lands after the first binary frame, once the LLM stream ends,
  instead of before the single audio blob. Both clients already handle
  `assistant_text` and `assistant_audio_start` independently in either order,
  so the inversion is wire-compatible. A one-chunk reply may still deliver
  text first.
- `turn_done` gains two additive fields only: `first_audio_ms` and
  `tts_segments`. Every other `turn_done` field is unchanged.
- A three-part interruption guard (turn-identity check at hook entry, a
  re-check immediately before every socket write, and a
  `writeAssistantAudio` null/closed-latch guard) is a hard precondition for
  shipping streaming and lands in the SAME commit as the multi-frame emit, not
  a follow-up. Without it a barge-in can interleave a dead turn's audio into
  the live turn and, on the shipped Android client, flip the global
  `assistantAudioOpen` window shut on the wrong turn.
- Rollback has two speeds. `VOICE_STREAMING=0` (or redeploying the previous
  ref) is the correct/slow path but needs a container recreate on the
  droplet (~30s, drops open voice sockets, which are client-retriable). A
  per-process streaming circuit breaker (3 streaming-path faults trips it)
  is the fast path: it needs no operator and no redeploy, because the
  promotion gate's `restore-check.sh` does not drive a real voice turn, so a
  fault that only reproduces on a spoken turn would otherwise keep
  re-promoting a bad ref.
- `VOICE_TTS_MAX_CHARS` (280) is untouched and keeps governing every
  non-streaming caller (browser-evidence speak caps, the profile default, the
  `VOICE_STREAMING=0` path). A new `VOICE_STREAM_MAX_CHARS` (1600) bounds only
  the streaming sanitizer's cumulative cap.
- Provider internals move behind a formal `voice-stages.js` seam
  (`SttProvider` / `Reasoner` / `TtsProvider`, registry-driven instantiation,
  `streaming_tts` / `streaming_reasoning` capability flags surfaced on
  `/health`). The outer transport contract — `processTurn(turn, hooks)`,
  `status()`, `synthesizeAssistantSpeech` — is unchanged, so the session
  server, Android, browser, and the LiveKit worker's internal voice hooks
  never see the stage seam.
- No turn-record schema change. N chunks still append into one
  `${turnId}.assistant.pcm` file, exactly like a multi-frame Gemini Live turn
  today. New metadata (`streaming`, `first_audio_ms`, `tts_segments`) is
  additive and passed through the existing optional-field spread pattern; old
  code reading a new record ignores the new fields, new code reading an old
  record treats their absence as the non-streaming default.

## What Changes

- **Wire protocol**: cascaded turns call `hooks.sendAudio(pcm)` once per
  synthesized chunk instead of once per turn. `assistant_audio_start` gains an
  additive `streaming: true` flag on streaming turns. The keepalive
  (`turn_progress`) keeps running through a streaming turn's inter-chunk gaps
  instead of stopping permanently at first audio, so a slow later sentence
  cannot trip the browser's post-commit inactivity watchdog.
- **Streaming LLM for voice turns**: a new `callModelToolLoopStreaming` runs
  beside the existing non-streaming `callModelToolLoop` for both the
  Vertex (`streamGenerateContent?alt=sse`) and OpenAI-compatible
  (`stream: true` SSE) reasoning paths, forwarding final-answer text deltas
  while still buffering and correctly returning tool-round-only text. Any
  transport/parse error inside a round falls back to one non-streaming call
  for that round.
- **Sentence/clause chunker**: a new pure module,
  `gateway/lib/voice-chunker.js`, slices streamed text into speakable chunks
  using sentence enders (including Ethiopic `። ፧ ፨`), clause enders once past
  a minimum length, and a hard split past a maximum length; a first-chunk
  policy makes the very first chunk leave for TTS as fast as possible.
- **Pipelined TTS**: a new internal `streamSynthesizedReply` helper
  synthesizes at most 2 chunks concurrently but emits them in strict order,
  aborts all pending/in-flight synthesis on interruption or a mid-stream
  fault, and degrades a synthesis fault to `tts_error` plus text-only delivery
  for the remainder of the turn rather than failing the turn.
- **Provider seam**: `gateway/lib/voice-stages.js` formalizes STT/Reasoner/TTS
  as small registry-driven interfaces; `VOICE_PROVIDER_REGISTRY` entries gain
  a `create(options)` factory, and `streaming_tts` / `streaming_reasoning`
  capability flags flow into `/health`.
- **Flags**: `VOICE_STREAMING` (per-turn env read, default on) plus an
  in-process streaming circuit breaker; `VOICE_STREAM_MAX_CHARS` as a new,
  separate cap from the untouched `VOICE_TTS_MAX_CHARS`; tuning envs
  (`VOICE_TTS_CONCURRENCY`, `VOICE_CHUNK_MIN_CHARS`, `VOICE_CHUNK_MAX_CHARS`,
  `VOICE_CHUNK_FIRST_MAX_CHARS`, `VOICE_CHUNK_FLUSH_MS`).
- **State compatibility**: additive turn-record fields only; one appended PCM
  file per turn as today; no migration.

## Boundaries

- Gateway remains the sole owner of provider routing, provider credentials,
  and voice-turn/session storage. Streaming changes gateway-internal files
  only (`server.js`, `voice-providers.js`, `voice-session-server.js`, the two
  new `lib/` modules); no client protocol additions land in this change.
- Model output remains a proposal: the reasoning stream still runs through the
  same tool sanitizers and profile-control gate hoisting as the non-streaming
  path before any text is spoken or persisted.
- No raw provider keys leave the gateway. The provider-seam refactor moves
  token/auth caching into a shared helper reused by both stages; it does not
  change which process holds credentials.
- Android and the browser extension need no protocol changes to play a
  streaming turn (both already tolerate N frames); their own hardening lanes
  (`android-compat`, `browser-compat`) verify against the shipped gateway
  behavior but do not add wire-protocol surface.
- This docs change must land in the same locally verified candidate as the
  gateway lane so `ARCHITECTURE.md` and the promoted runtime cannot drift.

## Verification

- Gateway: `cd gateway && npm run check && node scripts/smoke-cascaded-voice.js
  && node scripts/test-voice-chunker.js && npm run eval:voice`
- Android: `cd android_app && ANDROID_HOME="$HOME/Library/Android/sdk"
  ./gradlew assembleDebug`, then one phone voice turn against the promoted
  gateway.
- Browser: `cd browser_extension && npm run verify && npm run smoke`
- LiveKit worker: `cd livekit_worker && npm test && npm run build`
- Mandatory post-promote live QA (not optional observation): `moa-voice-qa`
  deterministic run plus one live spoken turn on the phone AND one in the
  browser, checking `/health` reports `streaming_tts: true` and
  voice-provider-events carry `first_audio_ms`.
