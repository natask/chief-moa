# Voice draft store repair contract 2

Status: BLOCK from independent correctness/security audit.

Repair only `gateway/lib/voice-drafts.js`, its focused tests/smoke, and this
slice's ledger. Do not integrate with the live voice server in this lane.

## Required repairs

1. Reconcile an outstanding append journal before every mutating operation in
   the same process. A later append must never overwrite an unreconciled
   journal. Add a fault-injection test proving persisted PCM survives retry.
2. Treat privacy cleanup as fail-closed. Do not clear `cleanup_pending` until
   all raw/audio/transcript artifacts are verifiably absent. Surface unlink
   failures and preserve retryable cleanup state.
3. Reconcile or securely remove atomic-write `.tmp` crash files. A discarded
   draft must leave no transcript/audio/journal temp artifact.
4. Reject symlinks and non-regular files at every draft path boundary. Opening
   or appending PCM must not follow a symlink outside the store.
5. Make lock takeover/finalization ownership-safe. Partial locks must be
   recoverable after a bounded stale interval, takeover must not unlink a new
   owner's lock, and release must remove only the lock owned by the caller.
   Acquire capture leases only after fallible history persistence, or roll them
   back on failure.
6. Exact idempotency: a repeated action key must compare the complete canonical
   request. `markSent` must bind actor, source, release, timestamp semantics,
   receipt, session, branch, draft, revision, and action. Reject any mismatch.
7. Reject invalid or overlong authority identifiers; never strip or truncate
   them into aliases. Exact session/branch identity is mandatory.
8. Enforce `maxSegmentBytes`, including declarations of zero. Declared and
   actual byte counts must match exactly.

## Verification

- `node --check gateway/lib/voice-drafts.js`
- `node --test gateway/test/voice-drafts.test.js`
- `node gateway/scripts/smoke-voice-drafts.js`
- Include deterministic regressions for every blocker above.

Do not commit, merge, or deploy. Report exact evidence and residual risks.

## Repair implementation evidence

Status: ready for independent re-audit.

- Outstanding append journals reconcile before each draft mutation; a
  same-process fault-injection retry preserves the fsynced PCM.
- Cleanup deletion is verified and retryable, known atomic-write temps are
  removed on boot/mutation, and content markers remain pending on failure.
- Draft files use no-follow regular-file boundaries, including audio, metadata,
  journals, locks, temps, reads, and cleanup paths.
- Operation locks carry unique owners, partial locks observe a stale interval,
  stale takeover checks file identity, and release checks the current owner.
- Transition, claim, append, and sent retry payloads are canonical and exact;
  authority identifiers reject invalid, conflicting, or overlong values.
- Segment byte limits and explicit zero byte declarations are enforced.
- Deterministic focused gate after repair: 22 tests passed, followed by
  `smoke-voice-drafts: ok`.
