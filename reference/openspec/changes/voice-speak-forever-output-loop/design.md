## Context

Produced 2026-07-16 against worktree branch `proj/chief-moa` (base
origin/master lineage); every file:line below was read in this checkout, not
recalled. Line numbers drift with the ongoing server decomposition — symbol
names are the durable anchors.

Three of the four continuous-voice pieces are shipped and live
(ancestors of `vps-deploy` 85c1d1ba):

1. **Chunked LLM→TTS streaming** — `createStreamingReplyPipeline`
   (`gateway/lib/voice-providers.js:1222`) chunks reasoning deltas, runs
   bounded-concurrency TTS (`VOICE_TTS_CONCURRENCY` default 2, clamp 1–4,
   `:1209-1211`), and emits strictly ordered PCM frames through an
   `emitChain` promise chain (`:1337-1377`). Invoked from cascaded
   `processTurn` at `:876`, gated by `streamingEnabledForTurn()` +
   `modality !== "text"` + `canSynthesize(pinnedLanguage)` (`:875`).
2. **Unbounded listening** — streaming STT with rotation and windowed
   fallback (shipped 7d1601db); no reply-length listening limit.
3. **Interruption capture + resume** — the per-frame text ledger
   `turn.assistantSegments` is fed by `sendAudio`'s `meta.segmentText`
   (`gateway/lib/voice-session-server.js:791-803`);
   `spokenProgressForTurn` (`:1150`) converts it plus the client's
   `played_segments`/`played_ms` cutoff report (`handleCancelTurn`
   `:1424-1431`) into `spoken_progress` on the canonical record
   (`recordIncompleteTurn` `:1200/:1239`); the next turn's context quotes
   the exact stop point via `interruptedAssistantLabel`
   (`gateway/server.js:13049`) and `playbackContinuationLines`
   (`server.js:9628`) inside both durable context builders
   (`voiceLiveContextPrompt` `:13096-13098`, `durableSessionContextBlock`
   `:13650-13652`).

The missing piece: nothing generates a NEXT segment voluntarily. The only
multi-round mechanism is the MAX_TOKENS auto-continue
(`server.js:8418-8430`): when a streaming round ends with
`finishReason === "length"` / `"MAX_TOKENS"`, the loop replays the truncated
text plus `AUTOCONTINUE_PROMPT` (`:8426`) and re-streams through the same
`emit`, bounded by `MODEL_AUTOCONTINUE_MAX_ROUNDS` (default Infinity) and
`isActive() !== false` (`:8566` OpenAI / `:8730` Vertex). That loop is the
proven template for this design — same emit continuity, same barge-in
threading — but it fires only on truncation.

The 2026-07-06 crash-loop postmortem constraint carries over unchanged: a
long-lived stream must never let a stale write cross a barge-in. A
speak-forever loop multiplies stream lifetime, so every existing guard
(`assertTurnActive` at hook entry `voice-session-server.js:596`, pre/post
socket-write re-check `:769/:785`, `TurnSupersededError` swallow in
`failCommittedTurn` `:1343-1348`) is a hard precondition, not hardening.

## Goals / Non-Goals

**Goals:**

- Let a cascaded voice turn keep producing spoken segments — the model
  self-prompting for the next narration beat — until the user interrupts,
  the model declares the narration finished, or a hard cap trips.
- One WS turn, one `assistant_audio_start` … frames … `assistant_audio_done`
  envelope; zero client changes (both clients already play arbitrary N
  frames; verified by the shipped multi-frame smokes).
- Generation may never run unboundedly ahead of playback: bounded segment
  buffer between the LLM and the speaker.
- Every existing exit works instantly: barge-in `session_start`
  (`voice-session-server.js:296-301`), `cancel_turn` (`:1413`), socket
  close (`closeCurrentTurn` `:1510`), `stay_silent` (`server.js:12609`),
  breaker trip (`voice-providers.js:203-223`), kill switch.
- Interruption mid-narration reuses the shipped `spoken_progress` chain
  verbatim — the ledger is already fed per segment, so "continue" after a
  barge-in resumes from the exact spoken word with no new persistence code.
- Default OFF end to end. Cost is real (one LLM round + N TTS calls per
  narration beat); nothing engages without an explicit user request or
  client setting AND the env master switch.

**Non-Goals:**

- No Live-provider (`legacy-live`) narration loop; `turn.liveSession` turns
  bypass `processTurn` entirely (`voice-session-server.js:499`).
- No text-modality loop: when `replyModality` resolves to `"text"`
  (`voice-providers.js:1508-1511`), the mode never engages.
- No persisted profile field — session-scoped override only, exactly like
  `response_modality` in `effectiveProfileForSession`
  (`voice-session-server.js:1738-1765`, "never persisted").
- No mid-loop checkpoint persistence of the canonical record (see Risks).
- No change to `AUTOCONTINUE_PROMPT`/truncation semantics; the two loops
  compose (a truncated narration beat auto-continues inside its round, then
  the narration loop decides whether there is a next beat).
- No new wire event types; additive fields only.

## Decisions

### D1. The loop lives in the reasoner layer, inside one turn

The narration loop wraps the reasoning call inside
`runCascadedVoiceReasoning` (`server.js:12162-12168`), NOT above
`processTurn` and NOT as gateway-chained turns.

Why: `runCascadedVoiceReasoning` already receives `onTextDelta:
speakSanitizer.push` and `isActive: input.is_turn_active` — deltas from
iteration k+1 flow into the same sanitizer → same
`createStreamingReplyPipeline` → same emit chain, so audio continuity is
free and the client sees one ordinary (long) streamed turn. The
`turn_done`-per-segment alternative (one canonical turn per beat, gateway
re-triggers itself) was rejected: it would fabricate turns with no user
input, complicate `spoken_progress` (which is per-turn), multiply canonical
records, and require client changes to suppress per-beat end-of-turn UI.

Consequence: `pipeline.finish()` (`voice-providers.js:1470`) is called once,
after the narration loop exits — `processTurn`'s existing structure
(`:979-1039`) already does this since the loop is inside the reasoner it
awaits.

### D2. Engagement: model tool + session override, behind a master env

Two engagement paths, both inert unless `VOICE_SPEAK_FOREVER=1`
(master switch, default OFF — the opposite polarity of `VOICE_STREAMING`,
deliberately, because this mode spends money in a loop):

1. **Model-decided** (primary): a `begin_continuous_narration` tool exposed
   alongside `stay_silent` (`server.js:12609-12612` pattern). The model
   calls it when the user asks for open-ended narration ("tell me a story
   until I say stop", "keep teaching me this"). The tool handler returns
   `{action: {type: "begin_continuous_narration"}}`; the reasoner latches
   loop mode for the remainder of the turn. System-prompt guidance lands
   next to the existing stop/silence instructions
   (`voice-providers.js:2144`, `:3622`).
2. **Client-decided**: additive `speak_forever: true` in the
   `session_start` profile override, validated and merged in
   `effectiveProfileForSession` (`voice-session-server.js:1750-1753`
   pattern), stored on `turn.effectiveProfile` (`:325`) — never persisted.

The deterministic control classifier is untouched: `"control"` →
silent-stop routing (`server.js:12261-12263`, `:12845-12859`) always wins
over narration.

### D3. Loop mechanics: self-prompt rounds through the same emit

Pseudocode (inside `runCascadedVoiceReasoning`, after the existing
`callModelToolLoopStreaming` call `server.js:12162`):

```
result = callModelToolLoopStreaming(messages, ..., {onTextDelta, isActive})
while (narrationEngaged && !finishRequested(result)
       && isActive() !== false
       && rounds < VOICE_SPEAK_FOREVER_MAX_ROUNDS
       && segmentsEmitted() < VOICE_SPEAK_FOREVER_MAX_SEGMENTS
       && elapsedMs() < VOICE_SPEAK_FOREVER_MAX_MS) {
  await pacingGate()                      // D4
  messages.push(assistant(result.text), user(NARRATION_CONTINUE_PROMPT))
  result = callModelToolLoopStreaming(messages, ..., same hooks)
  rounds++
}
```

- `NARRATION_CONTINUE_PROMPT` mirrors `AUTOCONTINUE_PROMPT`'s shape
  (`server.js:8426`): continue the narration from where it left off, do not
  repeat, do not re-greet; if the narration has genuinely concluded, call
  `finish_narration` instead of padding.
- **Model-decided exit**: a `finish_narration` tool (sibling of
  `begin_continuous_narration`). A round whose tool results include it — or
  that produces no speakable text after sanitization — ends the loop. A
  text sentinel was rejected: sentinels leak into TTS; a tool call is
  already sanitizer-invisible (tool-round text is buffered, `server.js:8582`).
- `stay_silent` in any round takes the existing path (`staySilent` detect
  `server.js:12195` → silent control shape `:12197-12209`) and also ends
  the loop.
- Each round is a normal `callModelToolLoopStreaming` call: tool rounds,
  the per-round non-streaming safety valve, and the MAX_TOKENS
  auto-continue all keep working inside a beat unchanged.
- Barge-in: `isActive()` is checked between rounds (above) and the
  existing delta/write guards cover mid-round — a superseded turn throws
  `TurnSupersededError` out of the pipeline hooks and `failCommittedTurn`
  swallows it (`voice-session-server.js:1343-1348`).

### D4. Pacing: segment-count buffer, not wall-clock

The next LLM round may not start until
`segmentsEnqueued - segmentsSentToSocket < VOICE_SPEAK_FOREVER_MAX_BUFFERED_SEGMENTS`
(default 6). The pipeline already tracks both numbers (enqueue assigns
`segment_index` `voice-providers.js:1331-1335`; the emit chain resolves per
send `:1363`); the pipeline exposes a `drainBelow(n)` promise for the
reasoner's `pacingGate()`.

Count-based was chosen over an estimated-playback-ms gate because it is
deterministic (testable in the smoke harness with no clock), bounds memory
directly, and the socket send already approximates playback order. A
`played_ms`-driven gate needs mid-turn `playback_progress` reports that only
Android sends reliably. Wall-clock pacing is a rejected alternative, noted
for a future tuning pass.

Bounded buffer also bounds interruption waste: at most ~6 segments of
synthesized-but-unheard audio are discarded on barge-in.

### D5. Caps and kill switches

| Env | Default | Meaning |
| --- | --- | --- |
| `VOICE_SPEAK_FOREVER` | `0` (off) | Master switch; when off, tools are not exposed and the override is ignored |
| `VOICE_SPEAK_FOREVER_MAX_ROUNDS` | `25` | LLM self-prompt rounds per turn |
| `VOICE_SPEAK_FOREVER_MAX_SEGMENTS` | `200` | TTS segments per turn |
| `VOICE_SPEAK_FOREVER_MAX_MS` | `600000` (10 min) | Wall-clock per turn |
| `VOICE_SPEAK_FOREVER_MAX_BUFFERED_SEGMENTS` | `6` | Pacing buffer (D4) |

Caps end the loop gracefully: the current round finishes, `finish()` runs,
`turn_done` reports `narration_stop_reason: "capped_rounds" | "capped_segments"
| "capped_ms"`. All three caps are deliberately finite — unlike
`MODEL_AUTOCONTINUE_MAX_ROUNDS`'s Infinity default — because this loop is
voluntary spend. The streaming breaker (`voice-providers.js:203-223`) is
unchanged and subsumes the loop: a tripped breaker disables the streaming
pipeline, and narration mode requires the streaming pipeline (a
non-streaming narration loop is explicitly not built), so
`narration_stop_reason: "streaming_unavailable"` ends it. Likewise a
mid-stream `ttsError` (`markFailed` `:1273`) ends the loop with
`"tts_error"` instead of degrading to an ever-growing text-only reply.

### D6. Persistence and wire: additive only

- One canonical record per narration turn, written by the existing
  `recordCompletedTurn` (`voice-session-server.js:1255`) /
  `recordIncompleteTurn` (`:1186`) → `recordStreamingVoiceTurn`
  (`server.js:538/12711`) path. Additive fields:
  `narration_rounds` (int) and `narration_stop_reason`
  (`"finished" | "interrupted" | "silenced" | "capped_*" | "tts_error" |
  "streaming_unavailable"`), mirrored onto `turn_done`. No schema
  migration; absent means "not a narration turn".
- `spoken_progress` on interruption: zero new code — the ledger and cutoff
  walk are segment-based and already handle N segments.
- **Durable-context tail guard** (the one genuinely new persistence-adjacent
  behavior): a completed narration turn's `assistant_text` can be tens of
  kilobytes. Both context builders currently inject the interrupted tail
  via `interruptedAssistantLabel`, but a COMPLETED long turn injects full
  text into the next turn's context. Add a tail truncation (keep the final
  ~1,500 chars with a `[...narration elided...]` head marker) applied in
  `durableSessionContextBlock` / `voiceLiveContextPrompt` when
  `narration_rounds` is present. This protects the next turn's prompt
  budget without touching non-narration turns.
- `turn_progress` keepalive (`MOA_VOICE_TURN_PROGRESS_MS`, default 5000,
  `voice-session-server.js:29/2094-2098`) already covers reasoner gaps
  between rounds — no watchdog change needed on either client.

## Risks / Trade-offs

- **Cost runaway** → default-off master env, model-side engagement only on
  explicit user request, three finite caps, pacing gate serializing LLM
  rounds behind playback. Worst case per turn is bounded by
  MAX_ROUNDS × per-round token budget and MAX_SEGMENTS × TTS chunk cost.
- **Process death mid-narration loses the whole turn record** — the
  canonical record is written once at turn end; a 10-minute narration that
  dies at minute 9 persists nothing (socket-close and cancel DO persist via
  `recordIncompleteTurn`; only a hard crash loses it). Accepted for v1:
  mid-loop checkpointing would touch the persistence gate
  (`voice-session-server.js:1231/1246` latch) that the crash-loop
  postmortem hardened, and the failure needs a gateway crash exactly during
  a narration. Revisit only with evidence.
- **Context poisoning across beats** — each round replays all prior beats
  as assistant messages; 25 rounds of drift can degrade quality. Mitigation
  is the finite round cap and the continue-prompt's do-not-repeat
  instruction; a rolling-window summarizer is out of scope.
- **Barge-in during the pacing gate** — `drainBelow(n)` must also resolve
  (reject) on turn supersession so the reasoner does not await a drain of a
  dead pipeline; `cancel()` (`voice-providers.js:1467`) already aborts the
  chain, the gate just needs to observe it.
- **Interaction with `VOICE_STREAM_MAX_CHARS`** — the streaming speak cap
  (`streamingSpeakCap` `server.js:12310-12315`, ceiling default
  `Number.MAX_SAFE_INTEGER` `:230`) applies per turn. An operator who set a
  finite cap would silently truncate narration; the loop treats hitting the
  speak cap as `"capped_segments"` rather than fighting it.

## Migration Plan

Gateway-only, additive, flag-gated OFF: deploys as dead code until
`VOICE_SPEAK_FOREVER=1` is set on the droplet. Rollback = unset the env (or
ship-revert; no data migration in either direction). Promotion rides the
normal master → `Deploy VPS gateway` path, currently frozen by the M4
evidence requirement (in-xqz) — this change does not attempt to unfreeze it.

## Open Questions

- Should the browser/Android UI surface a visible "narrating — tap to stop"
  affordance beyond the existing orb states? (Client lanes; not blocking
  the gateway loop, since barge-in and "stop" already work.)
- Should `begin_continuous_narration` accept a model-supplied plan/outline
  argument to stabilize long narrations? Deferred until quality evidence
  from real use.
- Amharic narration: gemini-tts am-ET content-policy 400s were observed
  2026-07-13 on single turns; a narration loop multiplies exposure. The
  per-round `ttsError` exit covers it, but am-ET narration may need a
  provider fallback before the mode is useful in Amharic.
