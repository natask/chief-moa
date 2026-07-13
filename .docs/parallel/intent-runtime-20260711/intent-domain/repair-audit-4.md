# Intent runtime repair contract 4: ownership-safe JSON lock lifecycle

Status: `BLOCK` found by the main orchestrator's post-CAS fault injection.

The compare-and-append rule now prevents duplicate stream versions, but one
filesystem cleanup failure can strand the process-shared JSON append lock for
the rest of the live gateway process.

## Reproduction

Using a real JSON event store with a 100ms lock timeout, inject `EACCES` into
the first unlink of the newly linked `.candidate-*` owner file:

1. `appendEvent` successfully creates the canonical `.append.lock` hard link.
2. Candidate cleanup throws before `acquireJsonAppendLock` returns ownership.
3. The append returns `EACCES` without writing the event.
4. Both the canonical lock and candidate remain.
5. A later append from the same live process returns
   `EVENT_SUBSTRATE_LOCK_TIMEOUT`; liveness recovery cannot reap its own PID.

Observed directory:

```text
product-events.jsonl.append.lock
product-events.jsonl.append.lock.candidate-<owner>
```

This is a release blocker even though the ordinary two-runtime test stores
`[1,2]`.

A second fault injection makes the failure ambiguous: forcing the owner-claim
rename to fail after the JSONL fsync leaves one durable event plus the canonical
lock. The first call returns `EACCES`; retrying its same idempotency key times
out instead of returning the already-written event. Recovery must cover both
pre-append acquisition cleanup and post-append release failure.

## Required repairs

1. A cleanup error after successful canonical lock acquisition must never lose
   the caller's ownership handle. Complete or unwind the owned critical section,
   retire the canonical lock with owner/inode proof, and surface any residual
   cleanup error without leaving future appends blocked.
2. Reconcile bounded candidate and claim artifacts. A process crash after
   creating a deterministic `.claim-*` hard link must not make that stale lock
   unreapable forever. Recovery may remove only an artifact proven to reference
   the observed stale inode/owner; it must never remove a successor's file.
3. Add real child-process tests, not only two store objects in one Node process:
   concurrent compare-and-append, owner exit/crash, partial/malformed lock,
   candidate-cleanup failure, claim/reaper crash, and successor-owner release.
4. Preserve the stable conflict class and the backward-compatible no-expected-
   version path. Exactly one conflicting command wins, retry of the winner's
   idempotency key returns its exact result, and stored versions remain `[1,2]`.
5. Fail closed on a symlink/nonregular event file or lock boundary. Do not read
   through a link that the append side would reject.

## Verification

- `node --check gateway/lib/event-substrate.js`
- focused child-process lock/CAS tests
- `node --test gateway/test/intent-runtime.test.js`
- `node gateway/scripts/smoke-event-substrate.js`
- `cd gateway && npm run check`
- `git diff --check`

Do not commit, merge, or deploy. A fresh reviewer must inspect the lock protocol
and repeat the failure injection after repair.

## Candidate repair evidence

Status remains `BLOCK` until a fresh reviewer repeats the fault injection and
audits the ownership protocol. The candidate repair does the following:

- It writes and fsyncs the complete owner record before hard-link acquisition,
  registers the canonical owner/inode handle before candidate cleanup, and
  retains failed cleanup as owned state instead of losing the critical-section
  handle.
- Release revalidates owner ID plus device/inode, retries the atomic
  canonical-to-retired rename, and removes only artifacts with that exact
  identity. If all rename attempts fail after the JSONL fsync, the same process
  retains an abandoned handle and reconciles it before its next acquisition.
  Cleanup after canonical retirement may surface an error but cannot block a
  successor.
- A reaper claim is a complete, fsynced record bound to the observed canonical
  owner/device/inode and to a live claimant process. The reaper revalidates the
  exact claim and stale canonical inode immediately before retirement. A dead
  claim is adopted through an atomic move and identity check; candidate, claim,
  and retired cleanup is bounded and identity-specific.
- Event and lock boundaries use `lstat`, `O_NOFOLLOW`, `fstat`, and a final
  path-identity comparison. Symlinks and nonregular files fail closed for both
  reads and writes.
- Existing compare-and-append behavior remains intact: the stable conflict
  class is unchanged, an exact idempotency retry precedes the version check,
  and callers that omit `expected_stream_version` still receive the substrate's
  next version even if they send a legacy `stream_version` value.

### Repeated fault evidence

- One injected `EACCES` on candidate unlink no longer aborts acquisition. The
  append succeeded, a following no-expected-version append received version 2
  (ignoring caller `stream_version: 99`), and no lock artifacts remained.
- One injected `EACCES` on the post-fsync canonical rename was absorbed by the
  bounded retry. With all three rename attempts injected to fail, the first
  call surfaced `EACCES`; an exact retry in the same live child process retired
  the retained owner, returned the already-durable version 1 event, and left no
  lock artifacts.
- A child exiting immediately after canonical acquisition (`71`) was reaped by
  exact stale identity before a version 1 successor append. A child exiting
  after event fsync but before release (`73`) left one durable event; retrying
  the same idempotency key returned that exact event and released the lock.
- A reaper exiting immediately after its durable claim (`72`) was adopted only
  after its claimant died. Recovery appended version 1, a successor appended
  and released version 2, and no artifacts remained. Two concurrent stale
  reapers produced exactly one winner and one stable version conflict; the
  subsequent successor also appended and released version 2.
- A stale malformed canonical lock recovered. Symlink event, symlink lock,
  directory event, and directory lock boundaries all rejected with
  `EVENT_SUBSTRATE_UNSAFE_PATH`; list reads did not traverse the unsafe event
  path.

### Candidate verification results

- `node --check gateway/lib/event-substrate.js`: pass
- `node --test gateway/test/event-substrate-lock.test.js`: 6 pass, 0 fail
- `node --test gateway/test/intent-runtime.test.js`: 17 pass, 0 fail
- `node gateway/scripts/smoke-event-substrate.js`: `ok: true`
- `cd gateway && npm run check`: 211 tests, 210 pass, 1 skip, 0 fail
- `git diff --check`: pass

No commit, merge, preview, promotion, or deployment was performed.
