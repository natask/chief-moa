# Implementation Contract: Voice Capture Drafts

## Boundary

A `voice_draft` is unsubmitted user input. It is distinct from:

- a canonical voice turn, which may run STT/reasoning/TTS/tools;
- an `audio_note`, which is intentionally storage-only and never submitted;
- operational telemetry, which is derived and loss-tolerant.

Pause, park, resume, and discard must never trigger a model response or tool.
Only explicit send admits the assembled draft into the existing voice-session
pipeline.

## State machine

```text
capturing -> paused -> capturing
capturing|paused -> parked -> capturing
capturing|paused|parked -> send_ready -> sent
capturing|paused|parked|send_ready -> discarded
```

Terminal states are `sent` and `discarded`. Repeating the same transition
with the same idempotency key returns the prior receipt. Illegal transitions
fail closed.

## Store API

Add a bounded file/blob store with injected event mirroring:

```text
create(input)
appendSegment(draftId, { segmentId, bytes, contentType, durationMs })
transition(draftId, { action, idempotencyKey, actor })
get(draftId)
list(filter)
segments(draftId)
readAudio(draftId)
claimForTurn(draftId, { sessionId, branchId, turnId })
markSent(draftId, receipt)
discard(draftId, command)
```

Metadata carries draft/session/branch/parent-intent/surface IDs, ordered segment
refs, total bytes/duration, optional bounded partial transcript, state, resume
count, release/deployment correlation, timestamps, and receipts.

Segments are immutable, cap-aligned PCM/audio blobs written atomically. Segment
IDs make append idempotent. Total bytes, segment count, and list/replay work are
hard-bounded. Discard deletes every content blob and partial transcript, then
keeps only a content-free tombstone and receipt.

## Gateway protocol

Authenticated additive routes:

- `POST /v1/voice-drafts` create metadata.
- `POST /v1/voice-drafts/:id/segments` append raw audio.
- `POST /v1/voice-drafts/:id/actions` pause/park/resume/send-ready/discard.
- `GET /v1/voice-drafts`, `GET /:id`, and `GET /:id/audio`.

`session_start` gains optional `voice_draft_id`. Only a `send_ready` draft
with matching session/branch authority may be claimed. The session server
replays its ordered audio into the normal turn/provider path, emits a source
receipt, and marks it sent only after the canonical turn is accepted. Provider
or turn failure leaves a retryable send-ready draft. Existing clients and
sessions without the field behave identically.

## Surface behavior

The voice-first hold path captures a draft locally and starts no provider
session until send:

- Release: upload/append current segment, mark send-ready, then submit through
  the existing voice-session path.
- Left: stop the microphone and retain the foreground draft locally; no commit.
- Up: upload/append and park; persist the returned draft ID locally; no commit.
- Down: stop capture, discard local/remote content, and show no response.
- OS `ACTION_CANCEL` / `pointercancel`: same as discard, never release/send.

The next hold resumes the foreground-paused draft. A later hold can resume the
last parked draft by appending a new ordered segment. Tap-based hands-free voice
may keep its existing streaming path. Legacy flag-off gestures remain
compatible.

Tap chords are: tap continue, double tap explicit new root, triple tap text.
New-root metadata must carry `context_action:new` and fail closed if the
gateway cannot create/switch the target.

## Gates

- Store transition/idempotency/quota/restart/order/discard tests and smoke.
- Fake provider counter proving pause/park/resume/discard invoke zero voice
  stages/tools.
- Send integration proving ordered draft audio enters exactly one canonical
  turn and a failed attempt remains retryable.
- Android direction + `ACTION_CANCEL` unit tests and full unit/build gate.
- Browser pure gesture test, `pointercancel` test, verify and smoke.
- Cross-surface restart smoke: park -> process restart -> resume -> send.

## Forbidden shortcuts

Do not relabel audio notes, treat `cancel_turn` as discard, buffer without
bounds, claim provider cancellation stops billing without evidence, silently
fall back to a current/default thread, store discarded content in telemetry, or
duplicate provider orchestration in a new HTTP handler.
