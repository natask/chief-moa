# Voice Draft Domain Repair Contract 1

## Audit disposition

`BLOCK`. Initial unit tests and smoke pass, but the store does not yet provide
restart-safe privacy, authority, or concurrent lease guarantees.

## Required repairs

1. Audio appends are legal only while `capturing`. `paused` is no-capture.
   `send_ready` must remain discardable before provider execution begins.
2. Every state/content mutation requires an integer expected revision. Preserve
   exact idempotent retries without allowing a stale revision to delete or
   mutate newer content. The `discard` wrapper must pass the revision through.
3. `markSent` must be idempotent. Idempotency records may not become reusable
   merely because a bounded display history evicted them; maintain durable
   bounded replay protection for terminal/action keys.
4. Lease/quota/revision authority must survive multiple store instances and
   processes. Use a file-backed atomic lock/CAS strategy with stale-lock
   recovery bounded by ownership evidence. Two stores must not both create or
   resume a capturing draft. Do not rely on process globals.
5. Make segment append crash-safe: temp blob + validated metadata/CAS + rename
   or an explicit recovery journal. A failed metadata write must not leave an
   unmetered/unreferenced blob. Boot must reconcile physical blobs, sizes,
   digests, alignment, ordinals, metadata totals, leases, and incomplete
   journals; corruption fails visibly or quarantines/parks without claiming
   valid audio.
6. Discard/consume privacy transitions must not leave content referenced after
   deletion, nor delete content while old metadata still claims it exists.
   Persist a content-free terminal marker/recovery intent first, delete content,
   then finalize idempotently so restart can complete cleanup safely.
7. Eliminate unmetered assembled-export accumulation. Prefer one canonical
   append-only PCM file, or create one bounded replaceable export included in
   quota and deleted/rebuilt safely.
8. Creation metadata is authoritative. Claims must match stored session and
   branch; missing creation authority is not a wildcard. `markSent` cannot
   invent a claim and must match a prior claim.
9. The minimum slice is canonical PCM16 mono 16 kHz only. Reject incompatible
   content types, odd byte lengths, size/digest mismatches, unsafe segment
   paths, and any assembled file outside the draft directory.
10. Additive mirror callbacks must isolate both synchronous throws and rejected
    promises without producing unhandled rejections.
11. Replace the shallow provider-import smoke assertion with adversarial unit
    tests for stale discard, sent retry, long idempotency history, dual-store
    lease contention, metadata failure injection, boot blob reconciliation,
    no export growth, claim authority, PCM/path integrity, and async mirror
    rejection.

## Owned files

- `gateway/lib/voice-drafts.js`
- `gateway/test/voice-drafts.test.js`
- `gateway/scripts/smoke-voice-drafts.js`
- This repair note and slice goal/ledger only.

## Verification

```sh
node --check gateway/lib/voice-drafts.js
cd gateway
node --test test/voice-drafts.test.js
node scripts/smoke-voice-drafts.js
```

The main orchestrator reruns these checks and a fresh audit before commit/merge.
