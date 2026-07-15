# Implementation contract: voice reliability timeline MVP

## Boundary

The timeline is a derived diagnostic projection. Canonical voice transactions,
audio objects, transcripts, intent history, and provider traces stay in their
existing stores. This module neither performs I/O nor defines a public
cross-vendor telemetry standard.

## Interface

`gateway/lib/voice-reliability-timeline.js` exports four pure operations:

- `normalizeVoiceEvidenceRecord(input, options)` validates and freezes one
  metadata-only record. `options.authority` supplies trusted server-owned
  `tenant_id` and `release_id` when needed; endpoint input cannot supply them.
- `recordsFromVoiceDiagnosis(diagnosis, options)` projects the existing
  `/v1/voice/diagnosis` result into server-observed records.
- `buildVoiceReliabilityTimeline(input, options)` validates endpoint records,
  enforces a single session/turn join, deduplicates, orders, and caps the
  result. Trusted server authority is accepted only through
  `options.authority`, never the ingest-shaped `input` object.
- `endpointPlaybackAttribution(timeline)` derives a conservative endpoint
  boundary result.

## Record shape

Every record has:

- `schema_version: 1`
- `event_id`, `session_id`, and `turn_id`: opaque authority tokens, 1-120 ASCII
  characters from `[A-Za-z0-9._:-]`
- `type`: one of `session`, `turn`, `server_audio_write`,
  `endpoint_audio_receipt`, `endpoint_observed_playout`, `transport`,
  `clock_calibration`, or `release`
- `source`: one of `gateway_observed`, `provider_observed`,
  `client_observed`, `deterministic_derived`, or `server_authority`. Existing
  diagnosis/archive projections are `deterministic_derived`; they are not
  mislabeled as a directly timed gateway milestone.
- `observed_at_ms`: non-negative safe integer wall-clock observation time
- optional `monotonic_ms`: non-negative safe integer local monotonic time
- optional `clock_id`: opaque process-clock epoch; required whenever
  `monotonic_ms` is present
- endpoint observations require one exact `observer_id` and `surface`
  (`browser_extension|android`) so evidence from different endpoint instances
  cannot be combined
- optional bounded scalar metadata documented in the module

The normalized record is at most 4 KiB. A timeline contains at most 256 records
and 512 KiB of input. Audio byte evidence is capped at 64 MiB per event;
durations at 24 hours; process monotonic clocks at 366 days; clock offsets at
24 hours; and uncertainty at five minutes. No free-form nested metadata or
unbounded arrays are accepted.

Server-owned `tenant_id` and `release_id` may appear only when trusted authority
is injected by the caller. `release` events require `server_authority` source.

## Allowed type-specific metadata

- `server_audio_write`: positive safe-integer `bytes`
- `endpoint_audio_receipt`: positive safe-integer `bytes`; optional bounded
  `buffered_ms`
- `endpoint_observed_playout`: non-negative safe-integer `played_ms`; optional
  bounded `measurement_uncertainty_ms`
- `transport`: `transport_state` in `open|closed|fault`; optional
  `transport_kind` in `websocket|webrtc|sip|http|local|unknown`
- `clock_calibration`: safe-integer `offset_ms` and non-negative safe-integer
  `uncertainty_ms`. Calibration is server-calculated evidence bound to an exact
  endpoint `observer_id`, `surface`, and `clock_id`; a client cannot assert it.
  The sign is fixed as `gateway_wall_ms = endpoint_wall_ms + offset_ms`.
- `session`, `turn`, and `release`: no additional mutable payload

Unknown keys are rejected. Empty strings, numeric strings, fractional integers,
non-plain objects, accessors, and alias fields are rejected rather than coerced.

## Sensitive-data rule

Reject forbidden keys recursively before shape validation, including names that
mean audio payload/body/blob, transcript, prompt, completion/content/message,
token/secret/key/password/authorization/cookie, tool arguments/results, or raw
headers. This is defense in depth; the closed shape is the primary boundary.

## Join and time semantics

- A build request names exactly one `session_id` and `turn_id`; every record
  must match both exactly.
- The MVP accepts one exact endpoint observer and process-clock epoch per
  timeline; it never combines receipt from one endpoint/epoch with playout from
  another.
- Event IDs are unique. Identical duplicate events collapse; conflicting
  duplicates fail.
- Ordering is deterministic: local monotonic order when two records share a
  source, otherwise wall-clock observation time, then event ID.
- Durations are computed only from monotonic timestamps on the same source,
  observer, and clock epoch.
- `observed_at_ms` is the time the evidence was observed, not automatically the
  physical milestone time. A `deterministic_derived` archive projection is
  sufficient for boundary attribution but never for server-to-endpoint latency;
  that measure waits for directly timed gateway plus calibrated endpoint data.
- Cross-source wall-clock ordering is marked `clock_relation: uncertain` unless
  an applicable calibration record bounds the relation. Calibration never
  fabricates a monotonic duration.

## Attribution states

- No `server_audio_write`: `status: no_server_audio_evidence`.
- Server write and no endpoint receipt: `status: endpoint_unknown`, with
  transport/playback unresolved.
- Endpoint receipt and no endpoint playout: `status: playback_not_observed`,
  boundary `endpoint_playback`.
- Endpoint playout: `status: endpoint_playout_observed`, boundary
  `endpoint_playback`, explicitly `human_heard: unknown`.

The tests must demonstrate that projecting the current gateway `emitted`
diagnosis stays `endpoint_unknown`, adding receipt changes it to
`playback_not_observed`, and adding observed playout changes it to
`endpoint_playout_observed`.

## Quality and resource threshold

- 100% branch-oriented coverage of every rejection/attribution rule in the
  focused test file.
- Pure synchronous CPU work only; no filesystem, database, network, timers, or
  environment access.
- Linear work in the bounded record count; no quadratic joins.
- `node --test test/voice-reliability-timeline.test.js`, full `npm run check`,
  and `git diff --check` must pass before audit.
