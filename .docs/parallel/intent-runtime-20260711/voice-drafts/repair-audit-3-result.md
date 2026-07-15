# Voice Draft Store Repair — Audit 3 Result

## Disposition

`GREEN FOR SLICE HANDOFF`

No commit, merge, or deployment was performed. Changes remain confined to the
voice-draft store, focused tests, smoke script, and slice documentation.

## Repaired Blockers

1. `create` now requires a strict idempotency key and persists the complete
   canonical create request in the authoritative draft metadata. Exact retries
   resolve before capacity and capture-lease acquisition, including after a
   lost response, park, or restart. Disagreeing retries conflict. Sensitive
   partial transcripts are represented in that request only by SHA-256.
2. Actor and correlation authorities are rejected when invalid or overlong;
   they are never stripped or truncated. Accepted aliases must agree exactly.
3. `markSent` binds source, surface, release ID, release version, session,
   branch, turn, actor, revision, receipt, timestamp semantics, and draft ID.
   Its durable receipt carries the draft and release ID/version.
4. A lock carrying the current numeric PID but a different process boot ID is
   considered stale and is reclaimed through the existing identity-checked
   takeover path.
5. `maxSegmentBytes: 0` is preserved as zero and rejects every non-empty
   segment instead of falling back to 8 MiB.
6. Discard and sent cleanup retain one bounded terminal idempotency entry
   after nonterminal history capacity fills, so privacy deletion cannot be
   blocked by that capacity. Exact replay and non-reuse remain durable.
7. Failed initial metadata persistence removes only a proven-empty draft
   directory. Startup removes empty interrupted-create remnants, and quota,
   status, and listing count only authoritative metadata-bearing drafts.
8. Persisted metadata and append journals now validate schema/state-machine
   revision, legal state, integer revisions and counters, strict identifiers,
   timestamps, hashes, segment arithmetic, aggregate totals, and nested
   claim/sent authority. Corruption fails visibly without rewriting evidence.

New recording directories are also forced to mode 0700; files and locks remain
0600.

## Deterministic Regression Evidence

`gateway/test/voice-drafts.test.js` now covers:

- create replay during active capture, after park, after store restart, and a
  canonical-field disagreement;
- overlong and invalid actor collision attempts, conflicting release aliases,
  release-version mismatch, complete receipts, and exact sent replay;
- current-PID/different-boot stale lock recovery;
- explicit zero segment limits;
- restart-safe discard after action-key capacity is full, including content
  absence and action-key non-reuse;
- injected failure of the first metadata atomic rename and empty-orphan startup
  recovery under `maxDrafts: 1`;
- fail-closed state, store revision, state-machine revision, draft revision,
  segment identifier, segment numeric field, and aggregate corruption without
  metadata rewrite.

## Verification

All commands passed in the slice worktree:

```text
node --check gateway/lib/voice-drafts.js
cd gateway && node --test test/voice-drafts.test.js
  29 tests, 29 pass, 0 fail
cd gateway && node scripts/smoke-voice-drafts.js
  smoke-voice-drafts: ok
git diff --check
```

## Assessed Integration Residuals

These remain explicit integration contracts rather than being silently folded
into the file-store slice:

1. **Tenant authorization:** the store keys records by session, branch, and
   draft, not by authenticated tenant. A gateway route must derive tenant and
   authority from trusted authentication context and prevent callers from
   supplying another tenant's namespace. This belongs to the gateway/API lane.
2. **Synchronous hashing cost:** canonical PCM validation and append digesting
   synchronously scan bounded files and can approach quadratic work across many
   appends. Current hard caps prevent unbounded storage, but a gateway exposure
   should move this work off the request event loop or adopt a verified
   streaming/worker design before high-volume use.
3. **Cross-process read snapshots:** metadata writes are atomic and mutations
   are locked, but read helpers do not retain a mutation lock for the lifetime
   of a returned stream. A concurrent append fails closed on size/digest
   mismatch; the gateway seam must define retry/snapshot behavior rather than
   treating that transient failure as data loss.

The directory-permission residual is closed for both newly created and existing
store/draft directories opened by this implementation: they are restricted to
0700 during use.
