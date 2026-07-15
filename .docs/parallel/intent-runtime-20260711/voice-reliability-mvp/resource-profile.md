# Provisional Moa-only recorder resource profile

This is an acceptance profile, not a production performance claim. Numbers stay
provisional until the browser/gateway integration runs the fault matrix below
on the target hardware. Failure to meet a threshold blocks enablement; it does
not justify silently loosening the threshold or dropping failed turns.

## Realtime admission budget

- Record construction: at most 4 KiB and 16 allowlisted scalar fields after the
  stricter schema walk; no audio/transcript/prompt/tool/model content.
- Event cadence: milestone events only, never one event per 20 ms PCM frame.
  Admit at most 64 records per turn, 16 records/second per active session, and
  256 records/second per gateway process. Excess increments a bounded drop
  counter by priority class.
- Synchronous work: validate, assign server authority/idempotency, and attempt
  one nonblocking in-memory enqueue. No network, disk, database, compression,
  model, evaluator, transcript, waveform, or content hashing on the voice path.
- Measured gate on the target process: enqueue p50 <= 0.05 ms, p99 <= 0.25 ms,
  max <= 1 ms under the declared offered load. Added end-to-end voice latency
  p99 <= 2 ms and <= 1% relative; added jitter p99 <= 1 ms. Both absolute and
  relative limits must pass.

## Memory queue and overflow

- One process-local queue, maximum 256 records and 1 MiB encoded bytes.
- One exporter in flight; batches contain at most 32 records / 128 KiB.
- Enqueue never waits. At capacity, deterministic priority is:
  1. retain terminal failure/drop/timeout and recorder-health counters;
  2. retain endpoint receipt/playout and server-write milestones;
  3. retain transport/calibration/release evidence;
  4. drop duplicate/detail records first.
- The reserved terminal/health partition is 32 records. A counter summarizes
  drops by event class, reason, and time bucket without session/turn IDs as
  metric dimensions.
- Queue plus exporter retained heap must remain <= 2 MiB above a recorder-off
  baseline after GC at steady state and <= 4 MiB during one batch.

## Export and local spool

- Export concurrency: 1. Attempt timeout: 2 seconds. No automatic concurrent
  retry; bounded exponential retry is 1, 2, 4, 8, then 16 seconds with at most
  5 queued attempts before spooling or dropping by priority.
- The exporter receives immutable normalized records. It cannot mutate the
  canonical turn, draft, intent, provider flow, or endpoint response.
- Optional local spool is outside the voice process's synchronous path. It is
  capped at 64 MiB, 24 hours, 10,000 batches, and one writer. Files are
  tenant/project scoped, checksummed, owner-only, and atomically published.
- Disk full, permission failure, checksum failure, corrupt spool entry, and
  unavailable backend open the recorder circuit and increment bounded health
  counters. They never fail or delay the canonical voice turn.
- Replay reads and query work use a separate worker/concurrency pool. They may
  not share the realtime exporter slot or unboundedly retain decoded timelines.

## Fault-test matrix required before enablement

Measure recorder off versus on with the same deterministic corpus and offered
load. Report sample count, p50/p95/p99/max, CPU, RSS/heap, bytes/events, and every
admitted/dropped/rejected/timed-out attempt.

1. Backend rejects every batch for ten minutes.
2. Backend accepts slowly beyond timeout and ignores abort.
3. Queue receives 10x declared event rate and 256 concurrent sessions.
4. Spool disk is full, read-only, replaced, corrupt, and slow.
5. Process crashes before enqueue, after enqueue, during batch, and after spool
   fsync/before rename; replay remains idempotent.
6. Timeline queries and spool replay saturate their own pool during active voice.
7. Browser disconnect/reconnect/replay sends duplicates, stale nonce, wrong
   origin/session/schema, oversize records, and clock-uncertain observations.

The test fails if canonical voice outcome/audio differs, any provider call is
added, a voice turn waits for recorder I/O, resource bounds are exceeded,
terminal/drop denominators disappear, or a percentile is reported without its
population and missing/dropped classes.
