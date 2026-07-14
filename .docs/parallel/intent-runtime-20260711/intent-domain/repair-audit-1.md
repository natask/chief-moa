# Intent Domain Repair Contract 1

## Audit disposition

`BLOCK`. The initial six focused tests pass but do not establish canonical
event-source correctness.

## Required repairs

1. Mutations must always rehydrate authoritative complete state with internal
   hard limits. Caller read limits must never influence lifecycle, focus,
   relation, or idempotency validation. If the authoritative history exceeds a
   supported mutation bound, fail closed rather than mutate from a prefix.
2. Capture must fail closed when the intent stream already exists. It may
   return the existing state only for the exact same idempotent capture. A
   duplicate capture must never resurrect or reset an intent.
3. Idempotency must be safe with the event substrate's global key namespace.
   Namespace generated and caller keys to the intent/operation, validate the
   append result, and never report target mutation when another stream owns a
   key. Concurrent check/append behavior must remain fail closed.
4. Clamp all read limits and result arrays to exported hard maxima. Never
   accept an effectively unbounded `max_events` or `limit`. `appendUnique` must
   also truncate an oversized existing input before adding values.
5. Replay must require capture first, validate payload intent against stream,
   reject/diagnose malformed order and illegal lifecycle/focus transitions,
   and not treat an arbitrary recognized event as existence. Commands still
   fail closed; forward-compatible unknown event types may remain diagnostic.
6. `connect` must require the target intent to exist. Transactional focus must
   require parent and return targets to exist and represent a reconstructable
   per-session focus stack. Pop must deterministically restore the parent/return
   target, not merely label the child popped. Add whatever canonical focus
   event payload/stream indexing is necessary without a second store.
7. Project rehydration must return the bounded rich fields required by the
   implementation contract: priorities, decisions, relations, blockers,
   plan/run/artifact/action/approval/receipt/source-receipt refs, lessons,
   outcome, and next step. When the scan is truncated, do not claim an exact
   total.
8. Align lifecycle legality with the strict OpenSpec graph. Do not allow direct
   captured-to-completed shortcuts unless the spec is explicitly changed and
   justified. Lesson events must still honor their allowed source states.
9. Reject overlong identifiers/idempotency keys instead of truncating values
   that can collide. Continue truncating bounded human text where the contract
   permits it.
10. Add adversarial tests for every item above, including Postgres-compatible
    substrate behavior where an injectable parity fixture exists. Do not fake
    concurrency or claim Postgres coverage if it is unavailable; record the
    remaining integration gate instead.

## Owned files

- `gateway/lib/intent-runtime.js`
- `gateway/lib/intent-runtime-router.js`
- `gateway/lib/intent-runtime-rehydration.js`
- `gateway/test/intent-runtime.test.js`
- This repair note and the slice goal/ledger only.

## Verification

```sh
node --check gateway/lib/intent-runtime.js
node --check gateway/lib/intent-runtime-router.js
node --check gateway/lib/intent-runtime-rehydration.js
cd gateway && node --test test/intent-runtime.test.js
```

Then the main orchestrator reruns the focused checks and a fresh independent
audit before committing or merging.
