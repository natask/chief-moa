# Rolling Transcript Reconciliation

## Why

Streaming Chirp is the correct latency path for conversation, but a later
batch pass over retained PCM produces materially better punctuation and word
recognition for long, self-correcting recordings. The existing explicit
re-transcription endpoint proved that quality gain on the 2026-08-02 production
turn, but requiring a manual request leaves ordinary voice history at streaming
quality.

The gateway should therefore reconcile retained audio in the background as
natural streaming-final boundaries become available. This is a transcript
quality lane, not a second turn-execution lane: finalization, reasoning, tools,
and TTS must retain their current latency and authority.

## What Changes

- Use streaming Chirp `isFinal` results and their `resultEndOffset` values as
  natural, provider-observed audio boundaries. Convert each boundary to an
  exact PCM byte span; do not split audio by text length, fixed wall-clock
  chunks, or guessed silence.
- Queue immutable, non-overlapping retained-audio spans for background Chirp 3
  batch recognition with bounded concurrency, queue size, and retry limits.
- Serialize completed corrected spans in source-audio order and publish a
  monotonic transcript snapshot containing `finalized_text` plus the current
  streaming `unsealed_text`. The live partial remains immediate.
- On turn commit, flush the remaining PCM tail asynchronously. Turn
  finalization, reasoning, tool routing, and TTS never wait for rolling
  reconciliation.
- Preserve the original streaming transcript as revision 0. Activate a later
  revision only after every span, including the tail, forms one nonempty
  corrected full-turn transcript. Reconciliation never reruns reasoning or TTS.
- Persist durable span claims and outcomes so recovery resumes unfinished work
  without duplicating successful paid STT calls.
- Fail soft when audio is not retained or accessible, privacy policy forbids
  the pass, the provider is unavailable, or capacity is exhausted.

## Capabilities

### New Capabilities

- `rolling-transcript-reconciliation`: asynchronous, audio-boundary-safe
  transcript correction and revision activation for retained voice turns.

### Modified Capabilities

None. The change is additive to streaming voice and the existing explicit
re-transcription revision contract.

## Impact

- Gateway streaming STT boundary metadata, retained PCM access, background work
  scheduling, transcript revision storage, and voice-session events.
- No Android or browser protocol break. Clients that understand the additive
  capability and identity-bound snapshot fields can update progressively;
  older clients keep the existing streaming transcript and later hydrate the
  activated revision from history. Android applies a finalized correction only
  to the exact retained user message and never to assistant text or an active
  capture.
- Each eligible audio second is recognized once by streaming STT and once by
  batch STT. Provider spend therefore approaches two STT passes per retained
  turn, plus bounded retry cost. Rolling spans also add provider request count,
  queue metadata writes, retained-audio reads, and short-lived worker memory.
  The feature needs explicit per-deployment concurrency, backlog, and eligibility
  controls rather than an unbounded default.
