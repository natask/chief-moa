# Intent domain fresh final audit 2

## Disposition

`PASS`.

The two blockers in `final-audit.md` are repaired. This audit changed no
product or test code and performed no commit, merge, preview, promotion, or
live-state operation.

## Configured lock age and exact live-instance ownership

- `gateway/lib/event-substrate.js:542-547` preserves the configured bounded
  `jsonLockStaleMs`. `jsonAppendLockIsStale` at `:667-679` compares age directly
  with that value; there is no one-second shortening.
- The predicate waits for the configured age, rejects remote-host reaping,
  never reaps this process's exact PID plus process-instance ID, recovers a
  same-PID prior instance only after the age threshold, and keeps legacy
  same-PID ownership conservative.
- `gateway/test/event-substrate-lock.test.js:257-303` performs a real append
  below a configured 30-second threshold, then recovery above it. The child
  fixture at `gateway/test/fixtures/event-substrate-child.js:64-93` injects the
  actual module-load process-instance ID, creates an aged lock with its own PID
  and that exact ID, and proves the append times out without reaping it.

## Focus-push compensation

- `gateway/lib/intent-runtime.js:238-267` defines and checks one globally
  namespaced compensation event before doing more work. A prior compensation
  returns the stable `INTENT_FOCUS_PUSH_COMPENSATED` result and cannot be
  duplicated.
- When the child half can no longer be admitted, `:294-315` requires the exact
  suspended return-target/child relationship, constructs one restoration from
  the latest return-target version, and appends it through the verified CAS
  path at `:91-105`.
- The ordinary retry path remains at `:268-323`; the executable immediate
  failed-half regression at `gateway/test/intent-runtime.test.js:604-641`
  still passes. The intervening terminal-transition regression at `:643-691`
  restores the parent and proves one compensation across repeated retries.

Additional read-only audit probes against the real JSON substrate proved:

1. A compensation append failing before persistence leaves the parent
   suspended but recoverable; the exact retry restores it, the next retry
   returns the stable compensated error, and exactly one compensation exists.
2. A lost response after durable compensation already leaves the parent
   focused; retry finds that event and creates no duplicate.
3. Two independent runtimes compensating concurrently both return
   `INTENT_FOCUS_PUSH_COMPENSATED`, while CAS/global idempotency stores one
   compensation and leaves no parent focus-child pointer.
4. If an independent legal parent transition wins after compensation planning,
   the first append returns `EVENT_STREAM_VERSION_CONFLICT`; the exact CAS
   retry compensates against the newer parent version. The final parent is
   focused, keeps the intervening terminal lifecycle, and has one compensation.

The transient conflict/failure requires the same ordinary exact retry contract
used by every compare-and-append mutation. It no longer creates an
unrecoverable half-pair.

## Verification

- `node --test test/event-substrate-lock.test.js`: 7 passed, 0 failed.
- `node --test test/intent-runtime.test.js`: 18 passed, 0 failed.
- `node scripts/smoke-event-substrate.js`: passed all JSONL, HTTP, chat, voice,
  and tool-event checks.
- Syntax checks for the event substrate and all three intent modules: passed.
- `npm run check`: 213 tests, 212 passed, 1 skipped, 0 failed.
- Tracked `git diff --check` and per-file no-index checks for every untracked
  slice file: passed.
