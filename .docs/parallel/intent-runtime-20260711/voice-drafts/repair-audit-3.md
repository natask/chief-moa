# Voice Draft Store Repair Contract — Audit 3

## Disposition

`BLOCK`

The advertised syntax, focused test, and smoke gates pass, but independent
adversarial checks found failures in create retry safety, authority binding,
persisted-state validation, lock recovery, configured limits, privacy cleanup,
and failed-create recovery. This contract is limited to the voice-draft store,
its focused tests, and its smoke script.

## Blocking Findings

1. **A lost `create` response is not retry-safe.** `create()` always allocates a
   new random draft and ignores a request idempotency key
   (`gateway/lib/voice-drafts.js:68-130`). An immediate identical retry fails on
   the active capture lease; after parking the first draft, it creates a second
   draft. The same logical create can therefore be lost or duplicated.
2. **Authority identifiers are canonicalized lossily.** Actor IDs are stripped
   and truncated by `normalizeActor()`/`cleanToken()`
   (`gateway/lib/voice-drafts.js:1474-1481`,
   `gateway/lib/voice-drafts.js:1677-1680`). Two distinct overlong actor IDs
   sharing the first 120 characters replay as the same actor. Invalid
   punctuation can collide for the same reason.
3. **`markSent` does not bind the complete release authority.** Its canonical
   command accepts lossy, conflicting `release_id`/`releaseId` aliases and omits
   `release_version` (`gateway/lib/voice-drafts.js:1511-1568`). A draft created
   with release version `1.2.3` was marked sent with conflicting release aliases
   and version `9.9.9`; a retry with a third release/version replayed the prior
   receipt. The receipt does not carry the release version.
4. **PID reuse can strand the store lock.** When a lock names the current PID
   but a different process boot ID, liveness falls through to `kill(pid, 0)`
   (`gateway/lib/voice-drafts.js:1375-1380`). An expired lock from a previous
   process incarnation was treated as live and returned 409 indefinitely.
5. **An explicit zero segment limit silently becomes the default.** Limit
   normalization uses positive-integer fallback
   (`gateway/lib/voice-drafts.js:1426-1439`). With `maxSegmentBytes: 0`, a
   non-empty append was accepted under the default 8 MiB limit.
6. **Idempotency-history capacity can prevent privacy deletion.** Once the
   action-key history reaches capacity (`gateway/lib/voice-drafts.js:1389-1424`),
   `discard()` can return 507 before erasing audio. A two-entry store reproduced
   this after pause/resume: state remained `capturing` and `audio.pcm` remained
   on disk.
7. **A failed first metadata write leaks quota.** If the initial atomic metadata
   rename fails, `create()` rolls back the lease but leaves an empty draft
   directory (`gateway/lib/voice-drafts.js:68-130`). Recovery does not remove
   that no-metadata directory, while draft counting still includes it. With
   `maxDrafts: 1`, every subsequent create returned 507.
8. **Persisted metadata is interpreted fail-open.** Restart normalization does
   not reject unknown states or incompatible schema/state-machine revisions and
   coerces malformed revisions/numerics (`gateway/lib/voice-drafts.js:894-964`).
   A metadata file with an unknown state, malformed revision, and incompatible
   store revision loaded successfully; revision was silently changed to 1.

## Required Repairs

### 1. Durable create idempotency

- Require a strict, bounded `idempotency_key` for `create` and persist the
  create request/result association under the global store lock before the
  caller can observe success.
- Canonicalize the complete create authority: idempotency key, session, branch,
  source/surface, release ID and release version, and every other field whose
  disagreement changes ownership or semantics.
- An exact retry after success, including after restart or a lost response, must
  return the original draft and must not reacquire or transfer its capture
  lease. A retry with the same key but any canonical-field disagreement must
  return a deterministic conflict.
- Never publish an idempotency result before both authoritative metadata and
  its index/record are recoverable. Reconcile interrupted create journal states
  before every mutation.

### 2. Strict authority and alias validation

- Reject invalid or overlong actor, source, surface, release, session, branch,
  draft, action, turn, and receipt identifiers. Do not strip, truncate, or
  otherwise map distinct wire identifiers to one value.
- Parse aliases with exact disagreement detection. In particular,
  `release_id` and `releaseId` must either agree exactly or fail. Apply the same
  rule to all authority/correlation aliases accepted by create, append,
  transition, claim, and sent commands.
- Make `markSent` bind the complete canonical request: actor, source/surface,
  expected draft revision, action key, draft ID, session/branch, turn/receipt
  IDs, timestamp semantics, release ID, and release version.
- The first sent transition must agree with authoritative creation/claim
  metadata; a retry must match the complete original command. Persist and return
  `draft_id`, `release_id`, and `release_version` in the sent receipt.

### 3. Strict persisted-schema recovery

- Validate the metadata kind, store schema revision, state-machine revision,
  legal state, integer revision, timestamps, segment IDs, sizes, offsets,
  durations, hashes, and aggregate counters before using a draft.
- Never repair unknown states or malformed authority/revision fields by
  fallback, truncation, or coercion. Surface deterministic corruption (or move
  the draft to an explicit quarantine that is excluded from mutations) while
  preserving evidence for diagnosis.
- Validate all reconstructed state after journal reconciliation with the same
  strict schema. A newer incompatible schema must fail visibly rather than be
  rewritten by older code.

### 4. Crash, lock, and quota recovery

- Treat an expired lock whose PID matches but boot/process identity differs as
  stale; reclaim it with compare-and-delete ownership checks. Preserve the rule
  that one process may never release another process's current lock.
- Define explicit `maxSegmentBytes: 0` behavior. Either honor it as accepting no
  non-empty segment or reject the store configuration at construction; never
  replace an explicit zero with a permissive default. Keep declared and actual
  byte counts exact, including zero-byte declarations.
- Make privacy deletion reachable even when replay-history storage is full.
  Reserve capacity or use a separate terminal tombstone mechanism so a valid
  discard can erase content while retaining enough durable identity to prevent
  action-key reuse.
- On failed create, remove only a proven empty, non-symlink, no-metadata draft
  directory. Recovery must likewise clean such interrupted-create remnants.
  Quota/status/list counting must include only authoritative drafts, not empty
  scaffolding.

## Required Regression Tests

Add focused tests that fail against the audited implementation and prove all of
the following without weakening assertions:

1. An exact create retry returns the same draft immediately, after park, and
   after store restart; no duplicate directory or lease is created.
2. A create retry with one changed canonical field conflicts.
3. Distinct overlong actor IDs and invalid-character collisions are rejected,
   not collapsed; the same applies to the other authority identifiers.
4. Conflicting `release_id`/`releaseId` aliases fail. A sent command or retry
   with the wrong/missing release version fails, and the receipt preserves the
   creation release ID/version and draft ID.
5. An expired lock with the current numeric PID but a different boot identity
   is reclaimed; a matching live owner remains protected.
6. The documented zero segment limit is enforced and declared/actual zero-byte
   behavior is exact.
7. Discard erases content after action-history capacity is exhausted, remains
   restart-safe and idempotent, and does not permit action-key reuse.
8. Injected failure of the first metadata atomic rename leaves no counted draft
   and does not consume `maxDrafts`; restart recovery reaches the same result.
9. Unknown state, incompatible schema/state-machine revision, malformed draft
   revision, malformed segment IDs, and inconsistent segment aggregates all
   fail visibly without rewriting the source metadata.
10. Run each recovery-sensitive case in a fresh process where process identity
    matters; do not mock away the file ownership or atomic-write boundary being
    asserted.

## Verification Gate

Run from the slice worktree:

```sh
node --check gateway/lib/voice-drafts.js
cd gateway && node --test test/voice-drafts.test.js
cd gateway && node scripts/smoke-voice-drafts.js
```

The repair is green only when these pass and the adversarial regressions above
are present. Do not satisfy the gate by deleting assertions, raising limits,
normalizing disagreeing inputs, or converting corruption into defaults.

## Residual Integration Risks To Record

These do not replace the blockers above, but the integration lane must account
for them before exposing the store as a gateway API:

- The store has no tenant/user namespace; route authorization must prevent one
  caller from addressing another caller's session, branch, or draft.
- Synchronous full-file reads and digest recomputation can block the gateway
  event loop and become quadratic across many appends despite bounded totals.
- Read paths do not share the mutation lock, so a concurrent append can expose
  a transient metadata/audio mismatch. Define snapshot or retry behavior.
- Draft directories inherit ambient directory permissions even though files are
  mode 0600; set and test a private directory mode for recordings.

## Do Not Touch

- Do not add provider calls to pause, park, resume, or discard.
- Do not merge the canonical turn/audio-note stores into `voice_draft`.
- Do not edit unrelated gateway, Android, browser-extension, or deployment
  surfaces in this repair.
