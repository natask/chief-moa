## Boundary and states

A draft is user-owned input before SEND. Pause/park/resume/discard invoke no
STT, reasoning, tool, TTS, broker, memory, or canonical turn writer.

```text
capturing -> paused -> capturing
capturing|paused -> parked -> capturing
capturing|paused -> committing -> consumed
capturing|paused|parked -> discarded
```

Revisioned transitions reject stale writers. Boot recovery parks orphaned
capturing/paused records. Consumed and discarded tombstones contain no audio or
transcript.

## Gateway capture path

A draft-mode `session_start` opens only a bounded draft PCM stream. Binary
frames never reach a provider. Pause/resume/park/discard are additive controls.
Existing `commit_turn` is SEND: it atomically closes/copies the PCM into the
ordinary turn path and continues through existing provider orchestration exactly
once. Failures after SEND use existing failed-turn semantics.

## Gesture contract

Under the voice-first flag, a still hold owns draft capture. Dominant direction
is latched beyond a threshold:

- release without direction: send;
- left: foreground pause;
- up: durable park;
- down: discard;
- `ACTION_CANCEL`/`pointercancel`: discard.

Pre-hold movement stays drag. Tap-based hands-free voice may keep streaming.
Flag-off behavior stays compatible.

## Storage and privacy

Per-draft and total quotas refuse new bytes without pruning another draft.
Metadata uses atomic replacement. Discard physically removes audio and any
partial transcript, retaining only bounded deletion evidence. Telemetry may
report an opaque operation result but never discarded content.

## Compatibility and rollout

Old clients omit `draft` and behave unchanged. New clients enable controls only
when health reports `voice_drafts_v1`. New/fork/incognito branch admission
fails closed. Active promotion requires additive-state compatibility,
backup/restore, no stranded capture/session, rollback, preview, and smoke.
