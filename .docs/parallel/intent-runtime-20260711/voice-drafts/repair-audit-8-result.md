# Voice Draft Store Repair — Audit 8 Result

## Disposition

`PASS — READY FOR FRESH INDEPENDENT AUDIT`

All five `final-audit-7.md` blockers now have implementation, exported-API and
restart regressions, and deterministic resource evidence. The original 47
tests remain green; the focused suite now has 53 tests. No route, provider,
Android, browser, deployment, active data, commit, merge, or promotion was
changed.

## Implemented Repairs

### Independently checkable compacted authority

- A compacted outcome retains the exact terminal history, sent claim and claim
  request (or exact nulls for discard), final revision, final mutation anchor,
  create request, terminal request/receipt, and durable action hashes
  (`gateway/lib/voice-drafts.js:1892-1947`).
- Stored compacted records cross-bind session, branch, turn, actor, source,
  surface, release ID/version, claim revision, terminal revision, timestamp,
  receipt, transition state, and action hash. A canonical SHA-256 decision
  digest covers the complete independently checkable payload
  (`gateway/lib/voice-drafts.js:1949-2105`).
- Single-anchor and jointly coherent request/receipt/claim mutations now fail
  before `get`, restart recovery, metadata rewrite, or evidence cleanup. The
  tamper matrix covers sent and discarded outcomes
  (`gateway/test/voice-drafts.test.js:2307`).

### Exact nonterminal mutation chains

- Every create, append, transition, claim, mark-sent, journal-recovered append,
  and boot-recovery park writes an exact mutation anchor. The anchor records
  mutation kind, predecessor revision, resulting revision/state, timestamp,
  and canonical request digest (`gateway/lib/voice-drafts.js:4929`).
- Persisted validation requires current state/revision/update time to equal the
  anchor, the latest retained transition to end in current state, segment /
  transition / claim predecessors to be unique and ordered, and the anchored
  request to be the exact latest mutation (`gateway/lib/voice-drafts.js:4335-4426`).
- The validation remains correct after bounded transition-history truncation
  because the newest transition is retained and the current mutation anchor is
  not truncated. Paused/capturing, segment, send-ready/claim, recovery, current
  revision, and truncated-history corruption regressions are at
  `gateway/test/voice-drafts.test.js:2378`.

### Dedicated orphan-recovery decision

- Boot recovery uses a reserved `recovery-park:<draft>:<resume-count>` decision
  and a digest-bound recovery receipt. It is recorded in transition history but
  does not consume or delete a client action-key hash
  (`gateway/lib/voice-drafts.js:971-1031`,
  `gateway/lib/voice-drafts.js:2776`).
- Caller-supplied transition keys in the reserved namespace are rejected.
- At exact user hash capacity, an orphan parks once, preserves both user
  hashes, reopens without another revision, replays the same recovery receipt,
  and still rejects another user transition with 507
  (`gateway/test/voice-drafts.test.js:2479`).

### Owner-file durability and interrupted lease recovery

- Owner creation is uncommitted until the parent directory fsync succeeds. A
  post-create durability error compare-removes only the exact inode and
  durably confirms that removal; an unconfirmed cleanup returns the explicit
  `voice_draft_owner_acquisition_cleanup_failed` outcome
  (`gateway/lib/voice-drafts.js:2465`).
- Recovery treats a live-looking capture lease whose authoritative draft was
  never published as an interrupted acquisition and removes it by exact owner
  identity (`gateway/lib/voice-drafts.js:807-853`).
- One-shot store-lock and capture-lease parent-fsync failures leave neither
  lock, permit same-process retry, and survive restart
  (`gateway/test/voice-drafts.test.js:2518`).

### Bounded keyed expired-replay index

- Excess terminal decisions now move into one root
  `expired-replay-index.json`, keyed by draft ID and SHA-256 create-key lookup.
  The full terminal directory is removed only after the index write is durable
  (`gateway/lib/voice-drafts.js:1841-1890`,
  `gateway/lib/voice-drafts.js:2131-2263`).
- Index-first compaction is restart-safe. If execution stops after the index
  write but before full-record removal, preflight accepts only an exact
  duplicate authority; the next restart validates it and removes the redundant
  directory (`gateway/test/voice-drafts.test.js:2658`). Corruption remains
  fail-closed and recognized index temp evidence is not removed around a
  corrupt index.
- `maxExpiredReplayRecords` and `maxReplayIndexBytes` are explicit hard limits.
  Each live/full record reserves a conservative future compacted-record byte
  budget. Create admission checks the sum of full and indexed decisions plus
  actual index bytes before any recording exists
  (`gateway/lib/voice-drafts.js:2265`). When count or bytes are full, a new
  create returns deterministic 507 backpressure; exact historical retries
  still return their keyed 410 outcome and no authority is deleted or reused.
- `status()` reports full, terminal, expired, and legacy-directory counts,
  actual draft+index metadata bytes, actual index bytes, both index caps,
  per-live-record reservation, and current reserved admission bytes
  (`gateway/lib/voice-drafts.js:743-789`).
- Mutations address indexed expired outcomes before attempting a filesystem
  lock, so compacted mutations remain deterministic 410 and valid absent IDs
  remain 404 (`gateway/lib/voice-drafts.js:2397`). Create lookup checks the
  keyed index before scanning the bounded set of full records
  (`gateway/lib/voice-drafts.js:2848`).

## Resource Measurements

Deterministic exported-API measurements on this checkout:

```text
count cap: maxDrafts=1, maxTerminalDrafts=1, maxExpiredReplayRecords=2
  admitted decisions: 3
  next admission: 507 replay authority capacity exceeded
  full records: 1
  indexed expired records: 2
  physical draft directories: 1
  index bytes: 6,824
  total full+index metadata bytes: 10,403
  reserved admission bytes: 60,152
  same-process reopen: 30.8 ms

byte cap: maxReplayIndexBytes=75,000, maxActionKeyHashes=2
  admitted decisions: 4
  next admission: 507 replay metadata byte capacity exceeded
  full records: 1
  indexed expired records: 3
  physical draft directories: 1
  index bytes: 10,125
  total full+index metadata bytes: 13,704
  reserved admission bytes: 43,133
  same-process reopen: 29.0 ms
```

The count-cap case previously produced one directory per historical decision.
It now stays at one full terminal directory plus one bounded keyed index. The
byte-cap case stops admission before either actual or reserved index usage can
cross the configured ceiling.

## Verification

Final isolated gate:

```text
node --check gateway/lib/voice-drafts.js
node --check gateway/test/voice-drafts.test.js
node --check gateway/scripts/smoke-voice-drafts.js
node --test gateway/test/voice-drafts.test.js
  53 tests, 53 pass, 0 fail
node gateway/scripts/smoke-voice-drafts.js
  smoke-voice-drafts: ok
git diff --check
per-untracked-file git diff --no-index --check
  no whitespace diagnostics
```

The old-base slice still has no `gateway/node_modules`, so the full gateway gate
must run after serial integration in the dependency-installed staging tree. The
last attempted old-base full run failed for missing `pg`, `ws`,
`@executor-js/sdk`, and `livekit-server-sdk`; the voice-draft tests passed
inside that run.

## Exact Residual Compatibility And Performance Debt

1. **Rollout/rollback boundary.** Full drafts now require `mutation_anchor`,
   recovery receipts carry a decision digest, and expired authority lives in a
   new root index. Older code cannot see index-only decisions and could reuse a
   key after compaction. This slice has never been merged or deployed, but any
   future rollout must be new-code-first with backup/restore evidence, and may
   not roll back to old code after the first index write without restoring the
   pre-index data snapshot or a compatible bridge.
2. **Old experimental expired markers.** The pre-audit-8 experimental
   per-directory marker lacks the independent claim/final-revision anchors and
   therefore fails closed rather than being silently upgraded. No active data
   uses that unmerged format. A migration would need the original full terminal
   evidence; it cannot safely invent missing authority.
3. **Bounded synchronous index.** Lookup is keyed and directory growth is
   eliminated, but the local fallback still parses and atomically rewrites one
   bounded JSON index. High-volume production should move replay authority to a
   transactional keyed table/event store while retaining these exact
   admission, non-reuse, backup, and restore semantics.
4. **Intentional lifetime backpressure.** The fallback never deletes the only
   replay/deny decision. It eventually returns 507 when its configured lifetime
   count or byte budget is full. Operators must migrate or deliberately expand
   the durable indexed store; manual deletion is not supported recovery.
5. **Synchronous audio snapshots.** Audio consumption remains digest-safe and
   per-call bounded, but allocates/hashes the full configured draft and has no
   aggregate live-snapshot budget. High-volume gateway integration needs worker
   or verified streaming isolation plus request concurrency limits.
6. **Tenant and filesystem boundary.** The file store remains tenant-neutral;
   authenticated routes must derive tenant/session/branch/release authority.
   Portable Node checks still lack native directory-FD protection against a
   hostile same-UID race, and other-process PID reuse needs stronger process
   birth identity or a transactional lease.

Do not commit, merge, integrate, deploy, or promote until a fresh independent
auditor returns `PASS` and the integrated full gateway gate is green.
