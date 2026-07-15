# Voice Draft Store Repair — Audit 10 Result

## Disposition

`PASS — READY FOR FRESH INDEPENDENT AUDIT`

All seven `final-audit-9.md` reproductions now fail closed or reconcile to a
usable same-process state. The 53 prior tests remain green and six new
exported-API groups cover the three repair classes, for 59 focused tests total.
No route, provider, model, tool, browser, Android, deployment, active data,
commit, or merge was changed.

## A. Canonical Mutation And Evidence Authority

- Every full draft now carries an exact, bounded `authority_chain` with one
  entry per revision. The chain covers create, append, every user transition,
  boot-recovery park, turn claim, and mark-sent. Each entry binds the draft ID,
  predecessor/result revision, state before/after, operation, time, canonical
  request digest, action-key hash, recovery class, current evidence digest,
  and predecessor chain digest (`gateway/lib/voice-drafts.js:3267`,
  `gateway/lib/voice-drafts.js:4927`).
- Validation replays the state machine in global revision order. Segment and
  transition predecessors can no longer be swapped while remaining unique;
  append is legal only at a chain revision whose state is `capturing`.
- The create entry is an immutable request/result root. Every later chain
  entry's evidence digest covers the complete current logical authority, so a
  changed create idempotency key, capture authority, or transcript hash fails
  before create replay lookup.
- The exact ordered non-system transition hashes in the chain must equal
  `used_action_key_hashes`. Removing, replacing, reordering, or reusing an
  evicted display-history key fails. Recovery entries remain separate and do
  not consume user capacity.
- Current partial transcript text and its update timestamp are part of the
  evidence root. Terminal entries also retain a digest-bound `pre_content`
  aggregate (bytes, duration, segment count, audio/segment/transcript roots),
  and terminal tombstone counts must match it
  (`gateway/lib/voice-drafts.js:5060`).
- Persisted audio validation now hashes every segment's exact PCM byte range in
  addition to validating the whole-file digest
  (`gateway/lib/voice-drafts.js:1937`,
  `gateway/lib/voice-drafts.js:5764`).
- Mark-sent now rejects a receipt/action key already consumed by another
  transition instead of writing an internally contradictory terminal record.

Regression evidence:

- cross-family append/pause predecessor swap is rejected before restart
  mutation (`gateway/test/voice-drafts.test.js:2711`);
- a parked draft's changed create key cannot allocate a duplicate ID, and every
  removed/replaced evicted action hash fails (`gateway/test/voice-drafts.test.js:2752`);
- create/append transcript+time changes, joint segment/request digest changes,
  and discarded tombstone count changes all preserve and reject the corrupt
  evidence (`gateway/test/voice-drafts.test.js:2812`).

## B. Exact Physical Root And Replay Index

- Store creation inspects an existing root before chmod, lock creation,
  recovery, or cleanup. The exact root schema permits only valid draft
  directories, the canonical replay index, bounded store/capture owner files,
  and recognized bounded replay-index temps. Unknown files, directories with
  invalid authority, symlinks, and special nodes fail closed and remain in
  place (`gateway/lib/voice-drafts.js:5834`).
- `status()` now exposes `physical_storage` with root/draft file counts and
  bytes, directory count, total entries, and total recognized bytes. It first
  performs exact root inspection, so it cannot return a green quota while an
  unknown root artifact exists (`gateway/lib/voice-drafts.js:850`,
  `gateway/lib/voice-drafts.js:5874`).
- All persisted JSON is scanned before `JSON.parse` with a bounded recursive
  parser that rejects duplicate decoded object-member names, including escaped
  equivalents. Exact replay-index map validation therefore receives an
  unambiguous representation (`gateway/lib/voice-drafts.js:2547`).
- The existing keyed replay representation, count/encoded-byte reservations,
  410 outcomes, 507 admission backpressure, one-full-directory turnover, and
  index-first recovery remain unchanged and green.

Regression evidence:

- a 1 MiB root recording under `maxTotalBytes:2` makes status/reopen fail while
  preserving every byte; a root symlink likewise fails without touching its
  target (`gateway/test/voice-drafts.test.js:2909`);
- duplicate textual draft-ID and create-hash members are rejected with the
  forged member both before and after the valid member, and the ambiguous index
  bytes remain unchanged (`gateway/test/voice-drafts.test.js:2945`).

## C. Ambiguous Atomic Publication Reconciliation

- Atomic writes now explicitly track `not_published`,
  `publication_durability_unknown`, and `published_verified`. After rename, a
  parent-fsync failure revalidates the bound directory, reopens and compares the
  complete target bytes, and retries parent durability. A persistent failure
  returns the typed `voice_draft_publication_durability_unknown` outcome with
  verified-publication evidence (`gateway/lib/voice-drafts.js:5583`).
- A verified ambiguous parked/send-ready/discard publication releases its exact
  prior capture lease before returning the error. A verified ambiguous resume
  keeps its exact newly published lease. An unpublished resume still rolls the
  lease back. Exact retry can therefore never report `capturing` while append
  has no lease, or report parked while capture remains occupied.
- Cleanup-marker/finalization publication uses the same primitive. A persistent
  finalization ambiguity leaves visible clean terminal metadata that exact
  retry validates; a marker ambiguity leaves retryable cleanup authority.
- Replay-index publication uses the same exact-byte/durability path. A full
  terminal directory is never removed on an unknown index publication, and an
  already-visible indexed outcome is directory-fsynced before later full-record
  removal.

Regression evidence (`gateway/test/voice-drafts.test.js:2976`):

- one-shot post-rename failure recovers in process for pause, park, resume,
  send-ready, discard, claim, mark-sent marker, cleanup finalization, and replay
  index publication;
- persistent park ambiguity throws the typed result, exact retry replays, and a
  new capture succeeds without restart;
- persistent resume ambiguity throws the typed result, exact retry replays, and
  append succeeds without restart;
- persistent cleanup finalization retries content-free; persistent index
  publication retains the full record until a later in-process durability
  confirmation removes it.

## Verification

Final isolated focused gate:

```text
node --check gateway/lib/voice-drafts.js
  pass
node --check gateway/test/voice-drafts.test.js
  pass
node --check gateway/scripts/smoke-voice-drafts.js
  pass
node --test gateway/test/voice-drafts.test.js
  59 tests, 59 pass, 0 fail, 0 skipped
  duration: 31,940 ms
node gateway/scripts/smoke-voice-drafts.js
  smoke-voice-drafts: ok
git diff --check
  pass
per-untracked-file git diff --no-index --check
  no whitespace diagnostics
```

All original process-lock, owner-fsync, journal, cleanup, exact-schema,
per-draft physical allowlist, lower-limit, immutable audio snapshot, compacted
authority, recovery-capacity, and replay-index tests remain green.

The old-base slice has no local `gateway/node_modules`, so the full gateway
suite remains a serial-integration gate in the dependency-installed staging
tree. This report does not substitute focused success for that gate.

## Exact Residual Compatibility And Performance Debt

1. **Required persisted field.** Full v2 drafts now require
   `authority_chain`. This slice was never merged or deployed, so no active
   record needs migration. Any future rollout is new-code-first; rollback after
   the first new record requires a compatible reader or snapshot restore.
2. **Bounded synchronous validation.** Every load validates the bounded chain
   and exact JSON structure. Audio-bearing loads hash every segment slice plus
   the whole PCM file. The work is bounded by configured counts/bytes but is
   synchronous; high-volume route integration still needs worker isolation and
   request concurrency limits.
3. **Integrity boundary.** The chained digests detect partial, reordered, and
   jointly local authority corruption relative to the retained predecessor.
   They are not a secret MAC against a hostile same-UID actor that can rewrite
   the complete database and recompute every root. Stronger host-adversary
   protection requires an external transactional/WAL or keyed integrity root.
4. **Portable filesystem ceiling.** Exact root/parent/inode checks still cannot
   provide native directory-FD `openat`/`renameat`/`unlinkat` guarantees against
   a hostile same-UID path race.
5. **Lifetime backpressure.** The bounded local replay index intentionally
   returns 507 rather than deleting the only deny/replay decision. Production
   scale should move it to the canonical transactional event/database layer
   while retaining these non-reuse and restore semantics.
6. **Tenant boundary.** The store remains tenant-neutral. Gateway integration
   must derive tenant/session/branch/release authority from authenticated server
   context.

Do not commit, merge, integrate, deploy, promote, or expose this slice until a
fresh independent auditor returns `PASS` and the dependency-installed gateway
gate is green.
