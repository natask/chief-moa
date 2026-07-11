# Intent runtime repair contract 3: real substrate CAS

Status: `BLOCK` found by the main orchestrator's post-repair adversarial run.

## Reproduction

Two independent `createIntentRuntime` instances sharing the real JSON event
substrate concurrently disambiguated one captured intent. Both commands
fulfilled and the stored versions were `[1, 2, 2]`.

The current test fixture simulates PostgreSQL rejection, but the actual JSON
adapter accepts a caller-supplied duplicate `stream_version`. PostgreSQL relies
on its unique index rather than an explicit expected-version contract. This
violates the slice acceptance requirement that JSON and PostgreSQL share the
same module contract and can leave locally canonical intent state corrupt.

## Required repair

1. Add an explicit compare-and-append contract to the existing event substrate,
   preferably `expected_stream_version` / `expectedStreamVersion`. The store
   computes the next canonical stream version under its write lock/transaction,
   rejects a mismatch with a stable conflict error, and assigns the actual
   `stream_version` itself.
2. JSONL compare-and-append must be process-safe, not merely a JavaScript mutex
   inside one runtime. Use an ownership-safe bounded lock/atomic append pattern;
   stale/partial lock recovery must not delete another writer's lock.
3. PostgreSQL must compare the expected version after its existing advisory
   transaction lock and before insert, returning the same conflict class as
   JSONL. Do not depend only on a database unique-constraint exception.
4. Intent runtime sends the expected version and verifies the returned assigned
   version. It never supplies an authoritative `stream_version` itself.
5. Add tests against the real JSON substrate with two independent runtimes and
   a PostgreSQL-compatible fixture. Exactly one conflicting command may win;
   the loser must fail closed, the stream must be `[1,2]`, and a retry with the
   winning idempotency key must return its exact result.
6. Preserve all existing event-substrate callers. Calls without an expected
   version retain the current append/auto-version behavior.

## Expanded ownership

For this repair only, the implementer may touch:

- `gateway/lib/event-substrate.js`
- its focused tests
- the three intent modules and intent focused tests
- this slice's docs

Do not touch server routes, schema, other stores, surfaces, deployment, or live
state. No commit/merge/deploy until the main orchestrator reruns both event-
substrate and intent gates and a fresh reviewer returns PASS.

## Candidate implementation evidence (2026-07-11)

The candidate leaves this contract in `BLOCK` pending the main orchestrator's
fresh audit, but implements the requested repair:

- JSONL and PostgreSQL accept `expected_stream_version` or
  `expectedStreamVersion`, compare it with the authoritative current stream
  version under the adapter's lock/transaction, throw
  `EventStreamVersionConflictError` with code
  `EVENT_STREAM_VERSION_CONFLICT`, and assign the next `stream_version`.
- JSONL acquisition writes and fsyncs a complete unique owner record before an
  atomic hard-link claim. Release and stale recovery use owner/inode validation
  plus an identity-specific hard-link claim and atomic rename, so cleanup never
  unlinks a successor lock. Acquisition is bounded and malformed partial locks
  must age past the stale threshold before recovery. Event records use
  `O_APPEND` while the process-shared lock is held, are fsynced, and the file is
  parsed strictly before each mutation.
- PostgreSQL reads and compares the current version only after the existing
  per-stream advisory transaction lock and the in-transaction idempotency
  lookup, then inserts the substrate-assigned next version.
- The intent runtime sends the expected current version (`0` for capture,
  otherwise the rehydrated state version), never sends `stream_version`, and
  verifies the adapter returned exactly `expected + 1`.
- The real JSON race test uses two independent stores and runtimes. Exactly one
  disambiguation wins, the loser has the stable conflict class/code, persisted
  versions are `[1, 2]`, and retrying the winner's idempotency key returns a
  deep-equal result without adding an event.
- The PostgreSQL-compatible client fixture proves advisory lock precedes the
  version read, a mismatch does not insert, the error class matches JSONL, and
  calls without an expected version retain auto-version behavior.

Verification evidence from the isolated intent worktree:

- `node --check lib/event-substrate.js && node --check lib/intent-runtime.js && node --check test/intent-runtime.test.js` — PASS.
- Focused CAS test pattern — 2 passed, 0 failed.
- `node --test test/intent-runtime.test.js` — 17 passed, 0 failed.
- `node scripts/smoke-event-substrate.js` — `ok: true`; JSONL, HTTP,
  chat-turn, voice-turn, and tool-request checks passed.
- `npm run check` — 204 passed, 1 skipped, 0 failed (205 total).
- `git diff --check` — PASS.

No commit, merge, preview, promotion, deployment, or live-state mutation was
performed.
