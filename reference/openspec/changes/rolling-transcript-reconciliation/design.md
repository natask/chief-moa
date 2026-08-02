## Context

The gateway currently streams PCM through Chirp, publishes immediate whole-turn
partial/final snapshots, retains eligible PCM, and can explicitly re-transcribe
a completed turn into a chronological revision. Streaming recognition favors
latency. Batch recognition over the complete retained signal has demonstrated
better accuracy, especially on long recordings, but a single post-turn batch
request delays the correction and can exceed an HTTP request lifetime.

Chirp streaming results already expose the two facts needed for safe rolling
work: `isFinal` says the provider has sealed a recognition segment, and
`resultEndOffset` identifies that segment's end in the source audio timeline.
Text itself is not an audio boundary and must never be used to cut PCM.

## Goals / Non-Goals

**Goals:**

- Keep live partial text at existing streaming latency.
- Improve retained transcripts continuously with batch Chirp recognition.
- Bind every correction to exact, immutable, non-overlapping PCM byte spans.
- Preserve ordered transcript snapshots and the complete revision history.
- Resume safely after process failure without paying twice for completed spans.
- Bound provider spend, memory, disk reads, concurrency, and backlog.

**Non-Goals:**

- No speculative reasoning, tools, actions, or TTS from corrected spans.
- No waiting for correction before `turn_done`, `transcript_finalized`, response
  generation, or audio playback.
- No raw-audio retention expansion and no override of deletion or privacy
  settings.
- No fixed-duration PCM chunking, fixed-size text chunking, forced silence
  insertion, or cutting inside speech to fill a batch target.
- No rewrite or deletion of revision 0.

## Decisions

### Decision: Streaming-final offsets seal exact PCM spans

For PCM16 mono audio, the gateway converts each accepted
`resultEndOffset` to the source sample index using the turn-pinned sample rate,
then to a frame-aligned byte offset. With `previous_end` initially zero, a new
strictly increasing offset seals `[previous_end, result_end)`. The span records
turn identity, ordinal, byte start/end, sample rate, audio-object generation or
digest, and the streaming boundary identity.

Offsets that are missing, malformed, non-increasing, beyond the durable audio
length, or not frame-alignable do not seal work. Repeated provider events are
idempotent. Once sealed, a span's bounds never change and later spans can only
start at its end. This makes overlap and gaps observable rather than something
a text-overlap heuristic hides.

Alternative: batch every N seconds or N characters. Rejected because it can cut
through a spoken word, has no exact mapping from text to retained bytes, and
turns provider timing into transcript corruption.

### Decision: Corrected snapshots combine sealed batch text with one streaming tail

Workers may complete out of order, but publication walks ordinals from zero and
stops at the first unfinished span. It joins only that contiguous corrected
prefix in source order. The gateway then publishes one whole-turn replacement
snapshot:

```json
{
  "sequence": 7,
  "finalized_text": "batch-corrected contiguous prefix",
  "unsealed_text": "current streaming text after the last sealed boundary"
}
```

`sequence` is positive and strictly increases for each published snapshot of a
turn. `finalized_text` never moves backward or substitutes an out-of-order
span. `unsealed_text` remains provisional and may be replaced as streaming
recognition evolves. Clients replace their display from the snapshot; they do
not concatenate snapshots.

The original low-latency `transcript_partial` path remains available
immediately. Rolling publication never waits for the next batch result before
showing the current streaming hypothesis.

### Decision: Client updates bind exact authority and message identity

The capability-gated rolling event binds owner/user, session, branch, turn, and
message identity. A prefix event carries `transcript_sequence`, batch revision,
`finalized_text`, `unsealed_text`, and one authoritative whole-text snapshot.
Android uses the whole text directly; it never infers overlap between the two
components or concatenates the event with its current display. It accepts only
strictly increasing sequence and batch revision values for the same identity.

A completed-revision event may update only the exact already-retained,
finalized user message when its revision is newer. It cannot target assistant
text, a different branch or turn, or the current capture editor. A polite
accessibility announcement may report that the transcript improved, but the
update does not steal accessibility or keyboard focus. Missing tail/completion
evidence leaves the finalized history message unchanged.

Alternative: patch whichever transcript is currently visible. Rejected because
a late background event could overwrite a new recording, the assistant reply,
or a message from another branch.

### Decision: Execution commits revision 0 and reconciliation activates later

`commit_turn` closes streaming recognition and proceeds immediately with the
existing resolved streaming transcript. That transcript is stored immutably as
revision 0 and remains the exact evidence used for that turn's reasoning,
tools, and TTS.

Commit also seals `[last_boundary_end, durable_audio_length)` as the tail when
nonempty and schedules it without awaiting it. Only after all spans have a
successful result does the gateway serialize the entire corrected transcript.
It appends and activates a new chronological revision only when that full text
is nonempty. Empty or incomplete output cannot replace revision 0. Activation
does not rerun context assembly, reasoning, tools, actions, or TTS, and history
continues to expose revision 0 beside later revisions.

Capture-only finalization follows the same asynchronous rule: its terminal
receipt reflects the streaming result, while an eligible corrected revision
may become current later.

### Decision: Claims make paid work restart-safe

Each span has a durable state machine such as `queued -> claimed -> completed`
or `retryable/terminal`. A claim records a unique attempt, lease expiry, and the
audio generation/digest. A worker durably stores the provider result and marks
the exact attempt completed atomically before publishing it. Recovery requeues
only unclaimed work and expired claims without a completed result; it never
reissues a completed span.

Provider timeouts create bounded retryable outcomes. Because a network failure
can occur after a provider accepted a request but before a result was durably
recorded, exact external once-only billing cannot be guaranteed without a
provider idempotency key. The gateway therefore uses one stable per-span
request identity where supported, records ambiguous outcomes, and caps retries
instead of claiming impossible exactly-once delivery.

### Decision: Privacy and availability fail soft

Eligibility is evaluated before enqueue and again before audio read. No work is
created when raw-audio retention is disabled. Deletion, expiry, owner mismatch,
digest mismatch, or a later privacy-policy change makes outstanding work
terminal without reading or recreating audio. Missing credentials, unavailable
Chirp service, invalid offsets, or provider failure leaves revision 0 readable
and the turn usable. Reconciliation errors are content-free diagnostics; they
do not copy transcript or raw audio into general logs.

### Decision: Backpressure bounds both cost and resource use

The queue has deployment-configured maximum pending spans, maximum eligible
audio duration/bytes per turn, global and per-owner concurrency, retry count,
and claim lease. Workers stream or bounded-read only one span at a time. When
the queue is full, new work is skipped or deferred with a content-free reason;
live STT, commit, reasoning, and TTS remain unaffected. Oldest eligible work may
be drained first, but active voice processing always has resource priority.

Operators can disable new enqueue independently of draining already-authorized
work. Metrics report counts, bytes/duration, latency, retries, skipped reasons,
and estimated provider cost without transcript content.

## Costs and trade-offs

- Eligible audio is sent to Chirp twice: once streaming and once batch. In the
  steady state this is approximately a 2x STT-audio processing volume for those
  turns, not a 2x total voice-turn cost because reasoning and TTS still run once.
- Natural boundaries can produce multiple batch requests, increasing per-call
  overhead versus one whole-file request. Coalescing is allowed only across
  adjacent already-sealed spans while retaining their exact outer bounds; it
  cannot invent a cut or overlap.
- Durable claims and results add small metadata writes per span. Retained PCM
  reads add disk/object-store traffic. Bounded workers protect the interactive
  path at the cost of correction arriving later during a backlog.
- Batch text can differ from what reasoning heard. Preserving revision 0 and
  recording the execution revision makes that distinction honest instead of
  silently rewriting historical causality.

## Migration and rollback

1. Add predecessor-readable reconciliation records and additive snapshot
   fields behind a disabled enqueue flag.
2. Prove exact byte-span derivation, ordering, recovery, privacy cancellation,
   and bounded load with deterministic fixtures.
3. Enable for a small duration-limited cohort and measure correction benefit and
   provider cost before widening eligibility.
4. Roll back by disabling new enqueue and allowing or canceling the isolated
   queue. Revision 0 and ordinary turn processing remain valid throughout.
