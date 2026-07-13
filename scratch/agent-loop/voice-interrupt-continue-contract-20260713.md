# Implementation contract — interruption position, auto-continuation, identity guard, latency (2026-07-13)

Source: user voice note 2026-07-13 + three diagnosis lane reports (latency,
identity, interruption map). Branch: `agent/voice-pipeline-orchestration`.

## Slice G1 — interruption position tracking (gateway)

Goal: an interrupted turn records exactly how far speech got, and the next
turn's context says so, so "continue" resumes at the cutoff.

- `gateway/lib/voice-providers.js` (`createStreamingReplyPipeline`): accumulate
  per-emitted-segment `{ text, cumulative_chars }` (after `state.emitted += 1`);
  expose `emitted_segments` from `finish()`/result and on abort.
- `gateway/lib/voice-session-server.js` (`handleCancelTurn`): accept additive
  `played_segments` (int) and/or `played_ms` on `cancel_turn`; stash on the
  turn before abort (position capture must happen before the superseded-turn
  silence guard).
- `gateway/server.js` (`recordStreamingVoiceTurn`): persist additive fields on
  interrupted records: `spoken_segments`, `spoken_chars`, `spoken_text`
  (prefix actually played, from segment ledger x client-played count; if the
  client sent no position, fall back to segments *sent*).
- `gateway/server.js` (`buildCanonicalContextArtifact` interrupted branch, plus
  the legacy `durableSessionContextBlock`/`voiceLiveContextPrompt` twins):
  render `(interrupted after speaking: "…<last spoken words>"; unspoken
  remainder: "<rest>")` so a "continue" turn resumes at the cutoff.
- Acceptance: cascaded smoke scenario — interrupt mid-stream with
  `played_segments`, stored record carries spoken_* fields, next-turn context
  block contains the cutoff text.

## Slice G2 — auto-continuation on token truncation (gateway)

Goal: reply truncated by max output tokens continues automatically within the
same logical turn (speak indefinitely), bounded.

- `gateway/server.js` `vertexStreamRound` / `openAiStreamRound`: capture and
  return `finishReason`.
- `vertexToolLoopStreaming` / `openAiToolLoopStreaming`: when a round ends
  `MAX_TOKENS`/`length` with no tool calls, append assistant-text-so-far to the
  conversation and re-issue, streaming through the same `emit` (extends
  `emittedText`, never replaces). Bound: `MODEL_AUTOCONTINUE_MAX_ROUNDS`
  (default 3). Non-streaming callers unchanged.
- Spoken cap interplay: `VOICE_STREAM_MAX_CHARS` still governs; raise default
  1600 -> 4800 so continuation is audible, keep env override.
- Acceptance: smoke with a tiny `maxOutputTokens` forcing truncation → final
  text is multi-round, coherent, single turn record, audio prefix ⊆ text.

## Slice G3 — identity guard + profile-write hardening (gateway)

- `profileIdentityInstruction()`: add always-on creator clause — created by the
  user (rendered via `user_address`, default "master"); never claim Google/
  Gemini/OpenAI/Anthropic or "a language model" as identity/creator. This block
  is injected on every path regardless of persona `system_prompt` overrides.
- `safeSystemPromptForProvider`: persona override AUGMENTS the base guard
  (append persona after base identity rules) instead of fully replacing it —
  preserve companion persona semantics (persona text wins on style/character)
  but keep identity/creator/never-say-Google rules present.
- Profile-control write guard: voice-sourced updates to `assistant_name` /
  `system_prompt` must pass sanity validation (name: <=40 chars, letters/
  digits/space/.- only, 1-4 words; system_prompt: reject when it looks like
  mis-transcribed run-on speech — min coherence: no trailing cut, length cap).
  Invalid values are rejected with a spoken error, never written.
- Live data repair (runtime op, not deploy): reset droplet profile
  `system_prompt` to empty (base prompt applies) and `assistant_name` to
  "A.G." via the gateway's own profile API; history jsonl is rollback.
- Acceptance: unit/smoke — persona-present profile still yields creator clause
  in assembled system instruction; garbage name write rejected.

## Slice G4 — latency (bounded, safe subset)

- `VOICE_CHUNK_FLUSH_MS` default 1200 -> 700 (env still overrides).
- Browser `VOICE_AUTO_COMMIT_SILENCE_MS` 900 -> 750.
- Context preflight (`prepareContextDecision`) — DO NOT reorder vs retrieval
  (contract from aaeacbb "decide context before retrieval"). Safe change only:
  skip the preflight RPC for trivially-continuing turns (short acks/continue
  phrases) with the previous decision reused. If not cleanly separable, defer
  and record as follow-up.
- STT streaming (`streamingRecognize`) is a follow-up lane, not this pass.

## Slice C1 — clients (browser + Android)

- Browser `content.js`: count segments whose playback actually completed
  (`source.onended`) + currently-playing offset; send `played_segments` on
  `cancel_turn`. Show interruption marker in the reply text UI if cheap.
- Android: `MoaAudioPlaybackController.stop()` reads
  `AudioTrack.getPlaybackHeadPosition()` → played ms; controller sends
  `played_ms` (+ frames written count) via `sendCancelTurn`.
- Both additive; gateway tolerates absence.

## Order + verification

G3 → G1 → G2 → G4 → C1. Gateway: `cd gateway && npm run check` + targeted
smokes (`scripts/smoke-cascaded-voice.js`, chunker test, `npm run eval:voice`
deterministic). Browser: `npm run verify && npm run smoke`. Android:
`./gradlew assembleDebug`. Deploy per active-promotion gate (VPS auto-promote
via master push once verified; extension packaged via deploy.sh).

## Slice G5 — mobile voice failure fixes (gateway)

Diagnosis (2026-07-13): ~half of Android turns silent. RC1: Vertex gemini-tts
returns content-policy 400 ("violates Vertex AI's usage guidelines", support
code 54702341) on am-ET replies — 23 hits in 48h, no fallback, Android
correctly never uses local TTS → silence. RC2: live profile `input_languages`
= ["am-ET"] only, so English speech → empty transcript → synthetic "Voice
captured." (85/449 turns). Transport/URL/auth verified NOT the cause.

- `gateway/lib/voice-providers.js` TTS leg: on a gemini-tts 400
  INVALID_ARGUMENT/usage-guidelines error, retry once WITHOUT the expressive
  style prompt (`input.prompt`, the most likely filter trigger); if the retry
  also fails, keep existing tts_error/text degrade (already wired) so the
  client shows text. Log a distinct `tts_content_policy` marker for tracking.
- Runtime data repair (droplet, via gateway profile API, reversible via
  history): `input_languages` -> ["en-US","am-ET"].
- Acceptance: smoke asserting the prompt-stripped retry fires on a simulated
  400-usage-guidelines error and succeeds; live QA one Amharic turn.

## Runtime repairs (live profile via API — do together)

1. `system_prompt` -> "" (restores base prompt + guards)
2. `assistant_name` -> "A.G."
3. `input_languages` -> ["en-US","am-ET"]
