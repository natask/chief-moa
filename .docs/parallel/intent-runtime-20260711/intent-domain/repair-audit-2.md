# Intent Domain Repair Contract 2

## Audit disposition

The first repair remains `BLOCK` on atomic focus, concurrent lifecycle writes,
strict replay occupancy/order, deterministic capture idempotency, and public ID
validation.

## Required repairs

1. Paired focus suspension/push and child-pop/return-restore must be retry-safe
   after either append fails. Inspect deterministic idempotency records before
   state-dependent event construction, resume the missing half, and support a
   return target distinct from the parent. Never leave an unrecoverable pair.
2. Serialize same-intent commands in-process and use explicit expected stream
   versions so PostgreSQL rejects concurrent writers. Validate the append result
   version. JSONL calls in this runtime must also be serialized; a losing
   concurrent command returns its exact idempotent result or fails closed after
   authoritative revalidation.
3. Any occupied stream blocks capture unless it contains the exact existing
   idempotent capture. Malformed/unknown-first records cannot be overwritten.
4. Strict replay diagnoses/rejects missing payload intent IDs, capture-first
   violations, early lessons, relation events whose target is absent from
   authoritative state, and premature/mismatched focus events. Runtime target
   checks remain mandatory even if replay cannot query another stream.
5. Capture idempotency shape is deterministic across time. Do not compare a
   regenerated timestamp; an exact retry returns the first capture while a
   changed canonical payload collides.
6. Every public read/rehydrate selector uses reject-on-overlength bounded ID
   validation before forming a stream key; no truncation aliasing.
7. Add fault-injection and `Promise.all` tests for each half of focus pairs,
   distinct parent/return, concurrent transitions, malformed occupied capture,
   strict replay ordering/identity, delayed capture retry, and overlong reads.

## Verification

```sh
node --check gateway/lib/intent-runtime.js
node --check gateway/lib/intent-runtime-router.js
node --check gateway/lib/intent-runtime-rehydration.js
cd gateway && node --test test/intent-runtime.test.js
```

Fresh independent audit is mandatory before commit/merge.
