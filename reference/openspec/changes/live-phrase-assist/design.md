# Design: Live Phrase Assist

## Protocol

`session_start` may include:

```json
{ "phrase_assist": { "version": 1, "enabled": true } }
```

Absence, a different version, or `enabled: false` leaves the feature off. The
gateway echoes capability state in `session_ready`.

An opted-in client sends `phrase_assist_request` with the active `turn_id`, a
bounded `request_id`, the exact `transcript_revision` last displayed, and an
optional `pause_ms`. It sends `phrase_assist_cancel` with the same turn and
request IDs when speech resumes. Transcript text is never accepted from these
client events; the gateway uses its latest provider transcript snapshot.

The gateway returns either:

- `phrase_assist_suggestion` with the request ID, revision, and bounded phrase;
  or
- `phrase_assist_done` with a content-free status such as `disabled`,
  `unavailable`, `stale`, `rate_limited`, `unchanged`, `busy`, `empty`,
  `canceled`, or `error`.

## Coordinator

Each active turn owns an in-memory transcript revision and snapshot. A changed
partial or final transcript increments the revision and aborts an in-flight
generation. The coordinator accepts at most one generation at a time, remembers
a bounded set of request receipts for idempotent retries, rejects unchanged
snapshots, and enforces a cooldown between accepted generations.

Commit, cancel, replacement, socket close, transcript revision, or explicit
phrase-assist cancel invalidates current work. A model completion is emitted
only if its generation is still current, its transcript revision still matches,
and the voice turn remains in `recording` state.

## Model Boundary

The adapter receives only the current normalized transcript. It uses an
explicit phrase-finding system instruction, a small output-token budget, a short
timeout, no saved profile instruction, no conversation context, no model tools,
and no native search. The output sanitizer collapses whitespace, removes a
label or surrounding quotes, and caps the result at eight words and 64 Unicode
characters.

The adapter is intentionally separate from the cascaded reasoner, broker,
intent runtime, device-tool protocol, and canonical turn recorder.

## Storage And Diagnostics

The snapshot and suggestion live only in connection memory and transient WS
events. Phrase assist does not create a new durable product record. Existing
voice transcript/provider persistence remains unchanged; phrase assist adds no
new copy of transcript or suggestion content. Its diagnostics record only
content-free lifecycle metadata.
