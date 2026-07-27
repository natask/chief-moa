# Voice Turn Latency: Prewarm The Post-Commit Critical Path

## Why

On 2026-07-27 the user asked for continuous background processing and
refinement while they are still speaking, not after they stop, stating the
goal as zero perceived latency and that they are willing to pay more for
it. It has no owning change and was flagged as an architecture question,
not a UI one.

This proposal traces the real turn lifecycle with file:line evidence, finds
that most of the pipeline already overlaps capture with processing, finds
the one genuine remaining wait, and rejects full speculative reasoning as
the first step because a naive version is measurably wasteful and risks
the same failure class the STT-garbage guard already exists to prevent.
It specifies the smallest step that is cheap, safe, and actually reduces
that wait.

### Where the time already overlaps with speech (not a gap)

- **Capture and STT already stream throughout recording, not after it.**
  Every PCM chunk is written to the turn's open streaming STT session as it
  arrives (`gateway/lib/voice-session-server.js:265-266`,
  `writeTurnAudio`), and interim/partial transcripts are broadcast live
  during recording, well before `commit_turn`
  (`gateway/lib/voice-session-server.js:692-695`, `transcript_partial`).
- **Chirp already finalizes clauses mid-utterance, not just at the end.**
  `gateway/lib/voice-stt-streaming.js:104-121` (`handleData`) appends every
  `isFinal` streaming result into `state.committedText` as it arrives,
  while `state.interim` holds only the still-unstable tail. By the time
  `commit_turn` fires, most of the transcript is often already finalized.
- **`commit_turn`'s STT step is a cheap finalize, not a fresh recognition.**
  `runSttStage` (`gateway/lib/voice-providers.js:1897-1918`) calls
  `turn.sttStream.finalize()`, which flushes only the last buffered chunk
  and appends the trailing `interim` text
  (`gateway/lib/voice-stt-streaming.js:313-334`) — it does not re-transcribe
  the whole utterance. The batch `transcribePcmWindowed` path is a fallback
  used only when the streaming session is missing or failed.
- **Context assembly already happens at turn start, not at commit.**
  `turn.contextPrompt = this.contextPromptForTurn(turn)` runs inside
  `handleSessionStart` (`gateway/lib/voice-session-server.js:383`), i.e.
  session history / gbrain recall / profile context is already resolved
  while the user is still talking, not after they stop.
- **TTS already streams per-chunk, not after the full reply is generated.**
  Per `ARCHITECTURE.md`'s "Streaming cascaded voice" section, the sentence
  chunker slices LLM deltas as they arrive and pipelined TTS synthesizes
  each piece in order; `assistant_audio_start` fires on the first chunk,
  mid-LLM-stream, not after the full reply.

None of that is duplicated or wasted work today — it is already the
speculative-in-spirit part of this ask, just under different names
(streaming STT, streaming TTS, prefetched context). This is not a gap to
close; it is prior work that already answers the "why does it feel slow"
complaint less than it might seem.

### The one genuine remaining wait

`CascadedVoiceProvider.processTurn` (`gateway/lib/voice-providers.js:781`)
does not call the reasoner (`this.reasonerStage.run(...)`,
`gateway/lib/voice-providers.js:910`) until `handleCommitTurn`
(`gateway/lib/voice-session-server.js:482`) has already run — i.e. the LLM
call is not issued until the user has released push-to-talk (or silence
auto-commit fires). Nothing before that point has asked the model a single
token's worth of question. The wait a user perceives after they stop
talking is, in order: STT finalize tail (small — see above) + reasoner
time-to-first-token + first TTS chunk synthesis + first-audio network
delivery. The first two of those already stream well. The reasoner call is
the one leg that is 100% sequential-after-commit today, with nothing
overlapped against the time the user was still speaking.

## Assessment: is this a hard architectural barrier, or just sequential-by-default?

Genuinely architectural: **the reasoner needs the user's actual, complete
question to answer it correctly.** Chirp's `isFinal` segments are stable
(once marked final, a segment is not revised — confirmed by
`voice-stt-streaming.js`'s `handleData`, which only ever appends to
`committedText`, never rewrites it), so the *words* of an early clause are
usually trustworthy. But the *intent* of an utterance is not: "remind me to
call mom... actually cancel that, email her instead" has a fully stable,
correctly transcribed first clause whose meaning is reversed by the second.
Speculatively reasoning over a stable-but-incomplete clause is a
correctness risk, not just a cost risk — a spoken reply to the wrong,
half-finished question is a worse user experience than the latency it
would save, and it is the same category of harm the existing STT-garbage
guard (`gateway/lib/voice-intent.js`, `gateway/lib/agent-profile.js`) was
built to prevent for profile writes: don't act on transcript content the
system cannot yet trust as the user's complete intent. That guard must not
be undermined by giving a different code path (speculative reasoning)
permission to act on the same kind of not-yet-complete evidence.

Merely sequential-by-default: **the reasoner and TTS provider connections
are established for the first time at commit, not opened during
recording.** No content-dependent work is at stake here — a warm TCP/TLS
connection and any provider-side session/auth token do not encode anything
about what the user said. This part of the wait has no correctness
tradeoff and is safe to move earlier.

## Cost Of A Naive Speculative Implementation (quantified)

Chirp's streaming STT emits an interim `transcript_partial` update roughly
every 100-300ms of active speech (typical streaming-STT interim cadence;
this repo does not yet log the exact per-turn count and Task 1 below adds
that measurement before any further speculative work is considered). A
4-6 second utterance — an ordinary turn length — therefore produces on the
rough order of 15-30 partial broadcasts. A naive implementation that
re-invokes the full reasoner (and, if carried further, TTS) on every
`transcript_partial` update would issue on that same order of LLM calls
per turn, of which only the last is ever used — a roughly 15-30x
multiplier on reasoner spend per turn, almost entirely discarded, before
counting the TTS side. Even a debounced version that only speculates on
new `isFinal` clause boundaries rather than every interim update is not
free: an ordinary multi-clause utterance still produces 2-4 clause
boundaries, so a clause-triggered speculative reasoner call would still
run 2-4x today's reasoner spend per turn under the optimistic assumption
that most clauses turn out to match the final intent — an assumption this
change does not have evidence for yet (see Task 1). The user said they are
willing to pay more, but "more" under a naive implementation is a double-
digit multiplier on the one paid leg of the pipeline (the reasoner call),
most of it wasted work with no latency benefit on the common case where a
clause's apparent intent changes before the turn ends.

## What Changes

1. **Prewarm the reasoner and TTS provider connections when recording
   starts, not when it commits.** During `handleSessionStart`
   (`gateway/lib/voice-session-server.js`, alongside the existing
   `contextPromptForTurn` prefetch), issue a connection-warm request to the
   configured reasoning provider and TTS provider — a cheap, content-free
   handshake/keepalive/auth-token-refresh call, not an inference call — so
   any idle-connection cost is paid during the time the user is already
   speaking instead of after they stop. This carries zero transcript
   content and therefore zero correctness risk, and issues no billable
   inference request.
2. **Measure the real cost/benefit of clause-triggered speculation before
   building it.** Add non-blocking logging (not a production behavior
   change) that records, per turn: the number of `isFinal` clause
   boundaries reached before `commit_turn`, and the elapsed time between
   the first `isFinal` clause and the eventual `commit_turn`. This tells
   us, from real traffic, whether most turns have enough of a stable early
   clause with enough dead time after it to make clause-triggered
   speculation worth its cost — instead of guessing.
3. **Do not build speculative reasoning or speculative TTS synthesis in
   this change.** That remains explicitly out of scope until Task 2's
   measurement exists and shows the win is worth the quantified cost above.

## Non-Goals

- No speculative LLM reasoning on partial or interim transcripts.
- No speculative TTS synthesis ahead of a committed reply.
- No change to when `commit_turn`, `processTurn`, or the reasoner actually
  runs relative to the transcript — only the provider connection is warmed
  earlier, never the content-bearing call.
- No new turn-cancellation or rework machinery. The existing barge-in
  cutoff ledger (`planVoiceTurnRelation`, the steering coordinator in
  `gateway/lib/voice-session-server.js`) already handles interrupting an
  in-flight turn's assistant audio when a *new* utterance starts; this
  change does not touch it and does not need it, because it introduces no
  speculative work to cancel.
- No weakening of the STT-garbage profile-write guard
  (`gateway/lib/voice-intent.js`, `gateway/lib/agent-profile.js`). This
  change adds no new path that acts on transcript content before it is
  finalized.
- No claim that "zero perceived latency" is achieved by this change. It
  removes one small, real, measurable slice of the wait (connection
  setup) and instruments the pipeline so a future, evidence-based decision
  can be made about whether clause-triggered speculation is worth its cost.

## Boundaries

- Gateway-only change. No Android, browser, or website changes.
- The prewarm call must be idempotent and safe to issue on every turn,
  including turns that are immediately canceled, and must not block
  `session_ready` from being sent to the client.
- Measurement logging (Task 2) must not add PII/transcript content beyond
  what stage-timing events already record today, and must not write to
  `DATA_DIR/voice-turns` outside the existing turn-record shape.

## Verification

- `cd gateway && npm run check` (existing gate, unchanged).
- A new deterministic smoke asserts the prewarm call fires at
  `session_start` (recording begin), not at `commit_turn`, using a fake
  provider double, and asserts it never blocks `session_ready`.
- Compare `first_audio_ms` (already reported on `turn_done` per the
  streaming-cascaded-voice contract) and the existing `reasoning`
  stage_start/stage_done timing between a cold-connection turn and a
  prewarmed turn in a controlled local run, to confirm a measurable (not
  necessarily large) reduction in time from `commit_turn` to first
  reasoner token.
- The clause-boundary measurement logging (Task 2) is verified by a smoke
  that feeds a multi-clause fixture through the fake streaming STT double
  and asserts the logged clause-boundary count and timing match the
  fixture's known `isFinal` sequence.
