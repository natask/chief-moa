# Voice Draft Store Final Audit 9

## Disposition

`BLOCK`

The audit-8 implementation passes all 53 authored focused tests, syntax,
deterministic smoke, and whitespace gates. It substantively closes the five
`final-audit-7.md` examples: compacted terminal records retain claim/final
anchors, current mutations have an anchor, orphan recovery has a dedicated
decision, owner-file acquisition cleans up after parent-fsync failure, and the
expired replay index has count/byte backpressure plus index-first crash
reconciliation.

Fresh persisted-state and exported-API probes still found seven release
blockers. The common authority flaw is that a full draft retains only the most
recent mutation anchor, while older creation, content, ordering, and replay-set
facts remain mutable without a durable chain or aggregate root. Separate
physical-store and durability faults also allow unaccounted root artifacts and
same-process lease stranding after an atomic rename whose parent fsync fails.
The replay-index JSON reader additionally accepts duplicate textual map keys
before exact-schema validation can see them.

No implementation, commit, merge, deployment, live data, provider, route,
Android, or browser surface was changed by this audit. Every direct probe used
a temporary data directory and removed it after the assertion.

## Passing Evidence

- `node --check gateway/lib/voice-drafts.js`: pass.
- `node --check gateway/test/voice-drafts.test.js`: pass.
- `node --check gateway/scripts/smoke-voice-drafts.js`: pass.
- `node --test gateway/test/voice-drafts.test.js`: 53 tests, 53 pass, 0 fail,
  0 skipped, 27,244 ms.
- `node gateway/scripts/smoke-voice-drafts.js`:
  `smoke-voice-drafts: ok`.
- `git diff --check`: pass before this report.
- Every untracked slice file passed
  `git diff --no-index --check /dev/null <file>` before this report. The
  expected ordinary exit code 1 means the untracked file differs from
  `/dev/null`; no whitespace diagnostic was emitted.
- The module imports only Node built-ins (`crypto`, `fs`, `path`, `stream`, and
  `util`). It contains no provider, model, tool, network, STT, LLM, or TTS
  dependency.
- The authored repair-8 regressions all ran green, including compacted sent /
  discard tamper matrices (`gateway/test/voice-drafts.test.js:2307`), exact-cap
  orphan recovery (`gateway/test/voice-drafts.test.js:2479`), store/capture
  owner-file parent-fsync cleanup (`gateway/test/voice-drafts.test.js:2518`),
  replay-index count and byte backpressure (`gateway/test/voice-drafts.test.js:2558`),
  and index-first full-directory removal recovery
  (`gateway/test/voice-drafts.test.js:2658`).
- The existing real child-process lease exclusion test also passed. No new
  concurrent-process corruption was observed by the authored gate.

The full dependency-installed gateway gate was not rerun in this old-base
slice, whose `gateway/node_modules` is absent. It remains an integration gate
after repair and serial merge; focused success does not override the blockers
below.

## Blocking Findings

### 1. Appends and transitions are not validated as one legal revision/state chain

Append is permitted only while `capturing`
(`gateway/lib/voice-drafts.js:290-295`). Persisted transition validation orders
only transition entries among themselves
(`gateway/lib/voice-drafts.js:3026-3077`). The later mutation validator orders
segments among themselves, then merely requires transition/claim predecessor
revisions not to duplicate a segment revision
(`gateway/lib/voice-drafts.js:4352-4375`). It never sorts every mutation by
revision and replays state legality. The one current anchor validates only the
latest request (`gateway/lib/voice-drafts.js:4377-4425`).

Direct restart probe:

1. Create revision 1, append at predecessor revision 1, pause at predecessor
   2, and resume at predecessor 3. The valid current record is `capturing`,
   revision 4.
2. Change the segment append request predecessor from 1 to 2 and the pause
   request predecessor from 2 to 1. Leave the resume request, receipts, current
   state/revision, and current anchor/digest unchanged.
3. Reopen the exported store.
4. Reopen succeeds and returns `capturing`, revision 4, with segment predecessor
   2 and history predecessors `[pause:1, resume:3]`.

That accepted history says pause changed revision 1 -> 2 and the append then
ran at revision 2 while the draft was paused, an operation the live API rejects.
The authored audit-8 test changes one isolated predecessor or removes the
latest entry (`gateway/test/voice-drafts.test.js:2378-2475`); it does not swap
two still-unique predecessors across mutation families.

Required repair:

- Persist one canonical mutation sequence or hash chain covering create,
  append, pause/resume/park/recovery/send-ready/discard, claim, and mark-sent.
- Replay retained/checkpointed mutations in global revision order, requiring
  every predecessor/successor revision and state to be legal. An append at a
  paused, parked, send-ready, or terminal revision must fail.
- If display history is truncated, retain a cryptographic/checkpoint aggregate
  that binds the omitted prefix and the exact state/revision at the retained
  suffix boundary; a latest-only anchor is insufficient.
- Add cross-family reorder matrices, not only one-field current-anchor tests.

### 2. A later mutation unbinds create idempotency authority and permits duplicate creation

Every operation calls `setMutationAnchor()`, which replaces the single
`draft.mutation_anchor` (`gateway/lib/voice-drafts.js:4929-4939`). On stored
full drafts, create validation compares session/branch/source/surface/release /
context fields but not a durable digest of the complete create request
(`gateway/lib/voice-drafts.js:1576-1590`). Create replay then scans whatever
`create_request.idempotency_key` the current records contain
(`gateway/lib/voice-drafts.js:2848-2883`).

Direct restart probe:

1. Create a draft with key `create-original`, then park it so the latest anchor
   is the park transition.
2. Change only persisted `create_request.idempotency_key` to `create-forged`.
3. Reopen the store; it accepts the changed create authority.
4. Retry the original exact create command.
5. The store allocates a second, different draft ID instead of replaying or
   conflicting with the first draft.

The authored create test proves retries while metadata remains honest
(`gateway/test/voice-drafts.test.js:866-919`); it does not prove that the
creation decision remains anchored after a later mutation.

Required repair:

- Retain an immutable digest of the complete create request/result in every
  full record and bind it into every later mutation anchor/checkpoint.
- Preflight and create lookup must validate that root before trusting the
  current key. A changed/missing creation root must fail without rewriting the
  record or allocating a new ID.
- Add one-field and jointly coherent create-key/capture-lease/transcript-hash
  tamper cases after append, park, recovery, claim, sent, and discard.

### 3. Evicted action-key authority can be removed and reused

`rememberTransition()` truncates transition history while retaining a separate
hash array (`gateway/lib/voice-drafts.js:2776-2792`). Stored validation requires
each *retained* history hash to be present
(`gateway/lib/voice-drafts.js:1607-1618`) and validates only the array's type,
cap, digest syntax, and uniqueness (`gateway/lib/voice-drafts.js:3235-3247`).
It does not bind the complete durable hash set or its prior cardinality to a
mutation root. `findRecordedAction()` treats absence from both current history
and that array as an unused key (`gateway/lib/voice-drafts.js:2757-2773`).

Direct restart probe with `maxTransitionHistory:1`:

1. Pause with `old-key`, then resume with `new-key`; only `new-key` remains in
   display history while both durable hashes are stored.
2. Remove only the evicted `old-key` hash from `used_action_key_hashes`.
3. Reopen succeeds.
4. Pause again using `old-key` at the current revision; the store accepts and
   executes it.

The ordinary no-tamper eviction test passes
(`gateway/test/voice-drafts.test.js:245-275`), but it cannot prove that an
evicted decision is still present after persisted-state corruption.

Required repair:

- Bind the append-only used-key set (or a keyed replay table/root) into every
  mutation checkpoint. Removing, replacing, or reordering a prior key must
  fail even when its display-history entry is gone.
- Preserve the dedicated system-recovery namespace separately without making
  user-key removal possible.
- Add restart tests that remove/replace every evicted hash position and prove
  the old key cannot execute.

### 4. Transcript, segment, and discarded-tombstone evidence is not bound to its claimed source

This is one authority-root class with three independently reproduced effects.

#### 4a. Current partial transcript and its timestamp can be forged

Create and append requests store transcript SHA-256 values
(`gateway/lib/voice-drafts.js:268-281`,
`gateway/lib/voice-drafts.js:2795-2845`), but stored normalization only checks
that the current transcript is bounded text and its update time is a canonical
timestamp (`gateway/lib/voice-drafts.js:1545-1553`). It never requires the
current value/time to match the latest content mutation that supplied it.

Changing only `partial_transcript` to `forged private content` and
`partial_transcript_updated_at` to another canonical time was accepted after a
create-only record and after an appended record. In both cases the persisted
create/append transcript digest stayed unchanged.

#### 4b. Per-segment digest metadata is not checked against its PCM slice

Stored parsing cross-checks a segment digest against the duplicate digest in
its append request (`gateway/lib/voice-drafts.js:4509-4585`). Physical audio
validation checks ordinals, offsets, totals, and the one whole-file digest
(`gateway/lib/voice-drafts.js:1728-1789`), but never hashes each
`offset..offset+bytes` slice and compares it with `segment.sha256`.

After append then pause, changing `segment.sha256` and the matching
`segment.append_request.sha256` together was accepted across restart while the
PCM bytes and whole-file `audio.sha256` remained unchanged. `readAudio()` still
returned the original PCM even though `segments()` advertised the forged
per-segment digest.

#### 4c. Discarded tombstone counts can be rewritten

Tombstone counters are only type/bounds checked
(`gateway/lib/voice-drafts.js:3969-4019`). Sent records cross-check them against
the retained send-ready audio receipt (`gateway/lib/voice-drafts.js:4225-4243`),
but the discarded path checks only receipt/time/actor/key authority
(`gateway/lib/voice-drafts.js:4310-4331`,
`gateway/lib/voice-drafts.js:4439-4449`).

After discarding a one-segment, four-byte, 10 ms draft, changing only all three
tombstone counters from `{4,10,1}` to `{0,0,0}` was accepted on restart.

Required repair:

- Bind the current transcript digest and update timestamp to the exact latest
  create/append content mutation, with an explicit rule for an append that does
  not update transcript text and for terminal clearing.
- Validate every segment digest against its exact PCM slice, or persist and
  verify a segment-manifest Merkle/hash-chain root that is itself bound to the
  verified whole-file digest.
- Before discard cleanup, persist an independently anchored pre-cleanup content
  aggregate and cross-bind the tombstone counters to it. Compaction may omit
  display counts, but a retained full tombstone may not claim arbitrary values.
- Add single and jointly coherent content/timestamp/digest/count tamper tests
  after a later transition has replaced the current mutation anchor.

### 5. Unknown store-root files bypass quota, privacy, and status accounting

Draft directories have exact physical allowlists, but the store root does not.
`listDraftDirectoryIds()` rejects symlinks and validates directories, then
silently skips every non-directory entry (`gateway/lib/voice-drafts.js:5081-5096`).
Audio accounting scans only authoritative draft directories
(`gateway/lib/voice-drafts.js:1798-1806`); metadata accounting scans only their
`meta.json` files (`gateway/lib/voice-drafts.js:1809-1816`). `status()` reports
those values plus the known replay index, not other physical root entries
(`gateway/lib/voice-drafts.js:743-786`).

Direct restart probe:

1. Open a store with `maxTotalBytes:2`, create and park an empty draft.
2. Place a 1 MiB regular file named `orphan-recording.pcm` directly under the
   private `voice-drafts` store root.
3. Reopen and call `status()`.
4. Reopen succeeds; the artifact remains, while `total_bytes` is 0 and
   `metadata_bytes` reports only the draft metadata.

This is both a resource bypass and a sensitive-artifact blind spot. It is
distinct from the already-green exact per-draft physical schema.

Required repair:

- Define an exact root schema: draft directories plus only the canonical replay
  index and explicitly bounded lock/recognized atomic-temp scaffolding.
- Fail before mutation when an unknown regular file, directory, symlink, FIFO,
  socket, device, or malformed temp exists. Preserve unknown evidence; do not
  silently delete it during startup.
- Report all known physical bytes and entry counts, including replay index,
  live owner files, and recognized temps, with an explicit unknown-artifact
  failure rather than a green quota.
- Add lower-quota restart and `status()` regressions for root files/nodes.

### 6. Post-rename directory-fsync failure leaves published metadata and mismatched leases

`atomicWrite()` renames the temporary file onto the authoritative target and
sets `renamed=true` before parent-directory fsync
(`gateway/lib/voice-drafts.js:4870-4905`). If that fsync throws, callers receive
an error even though the new metadata is already visible. Transition error
handling assumes the write did not commit: a parked resume releases its newly
acquired lease (`gateway/lib/voice-drafts.js:500-512`), while park/send-ready /
discard release the prior capture lease only after the write returns success
(`gateway/lib/voice-drafts.js:514-516`). Exact duplicate replay returns before
either repair path (`gateway/lib/voice-drafts.js:406-410`).

Two one-shot parent-directory-fsync probes reproduced opposite broken states:

- **Park:** the call returned 500 after rename, disk metadata was `parked`, and
  the old physical `capture.lock` remained. Exact park retry returned the
  recorded `parked` receipt, but a new create returned 409 because the stale
  live lease still occupied capture. Restart released it.
- **Resume:** the call returned 500 after rename, disk metadata was
  `capturing` with a capture lease, and the physical lease had been rolled
  back. Exact resume retry returned a successful `capturing` receipt, but the
  next append returned 409 because no active lease matched. Restart auto-parked
  the draft.

The repair-8 owner-file tests cover failure while publishing the owner file
itself (`gateway/test/voice-drafts.test.js:2518-2556`). They do not cover an
already-renamed `meta.json` whose directory durability confirmation fails.

Required repair:

- Represent atomic publication as `not published`, `published and verified`,
  or `publication durability unknown`. On an unknown result, read the target
  back through the bound directory and compare the complete intended record
  before deciding lease cleanup.
- Reconcile physical lease and authoritative state before returning an exact
  duplicate receipt and before any later create/append/transition. A parked /
  terminal published record must release its exact old lease; a published
  capturing resume must retain/reacquire the exact new lease or fail into an
  explicit recoverable state, never replay success with no lease.
- Apply the same ambiguity rule to index publication and cleanup markers.
- Add separate post-rename parent-fsync cases for pause, park, resume,
  send-ready, discard, claim, sent, cleanup finalization, and replay-index
  publication, each proving same-process retry and restart.

### 7. Duplicate textual keys in the replay-index JSON are accepted

The replay index is first decoded with ordinary `JSON.parse()`
(`gateway/lib/voice-drafts.js:2119-2128`,
`gateway/lib/voice-drafts.js:2356-2378`). Exact map validation then sees only
the parser's last value for a property (`gateway/lib/voice-drafts.js:2131-2189`).
It cannot detect duplicate property names in the stored bytes.

Direct replay-index probe:

1. Produce one valid compacted outcome.
2. Insert a leading duplicate `records_by_draft[<same draft id>]` property with
   a forged object, followed by the existing valid property.
3. Insert a leading duplicate `draft_by_create_hash[<same hash>]` property with
   a forged draft ID, followed by the existing valid property.
4. Reopen the store.
5. Reopen accepts the ambiguous file and returns the last, valid compacted
   record. The forged duplicate members remain in the persisted bytes.

This does not break Node's current last-value lookup, but it violates the
store's exact persisted-schema claim and makes backup, migration, audit, or a
different parser free to select contradictory authority.

Required repair:

- Reject duplicate JSON object members before ordinary object materialization,
  or store the index as a canonical entry sequence/table with explicit key
  uniqueness and canonical-byte verification.
- Add duplicate textual draft-ID and create-hash cases where the forged member
  appears first and last. Rejection must preserve the exact file bytes.

## Reproduced Repair-8 Guarantees

The following behavior remains green and is not the cause of this block:

- compacted sent/discarded records reject the authored one-field and jointly
  coherent claim/final-anchor tampering;
- every authored isolated current state/revision/claim/recovery corruption is
  rejected;
- exact user action-hash capacity still permits one deterministic system
  recovery park and rejects another user action with 507;
- store-lock and capture-owner parent-fsync failures remove their exact owner,
  permit retry, and survive restart;
- the replay index enforces its authored record and encoded-byte caps, returns
  keyed 410 outcomes, produces 507 admission backpressure, stays at one full
  directory in ordinary turnover, and reconciles the authored index-first
  interruption after restart;
- exact nested schemas, per-draft physical allowlists, symlink checks,
  cleanup evidence preservation, strict numeric/time inputs, verified audio
  snapshots, and valid missing-draft 404 outcomes remain green.

These are meaningful improvements. They do not detect the authority-prefix,
root-schema, or ambiguous-publication failures above.

## Focused Repair Contract

Repair in three independently auditable slices so one class cannot mask
another:

1. **Authority-chain and evidence binding**
   - global mutation/state/revision chain;
   - immutable create root;
   - durable used-key-set root;
   - transcript/segment/tombstone content aggregates;
   - exact compact/checkpoint rules after bounded history truncation.
2. **Physical root and replay-index schema**
   - exact root allowlist and complete physical accounting;
   - duplicate-member rejection/canonical index representation;
   - retain existing bounded keyed lookup, 410, 507, and index-first recovery.
3. **Ambiguous atomic publication reconciliation**
   - post-rename parent-fsync outcome detection;
   - same-process metadata/lease reconciliation before duplicate replay;
   - focused cases for every lease-changing transition and the replay index.

Retain all 53 current tests and add regressions for every direct reproduction in
this report. Do not satisfy the gate by dropping old hashes, permitting a
finite untracked prefix, raising caps, deleting unknown artifacts, treating
restart as the only same-process repair, or recomputing an integrity digest
from already-forged fields without an independently anchored predecessor.

## Re-Audit Gate

After repair, run:

```sh
node --check gateway/lib/voice-drafts.js
node --check gateway/test/voice-drafts.test.js
node --check gateway/scripts/smoke-voice-drafts.js
node --test gateway/test/voice-drafts.test.js
node gateway/scripts/smoke-voice-drafts.js
git diff --check
```

Also run per-untracked-file whitespace checks in the isolated slice and the
full dependency-installed `gateway npm run check` after serial integration.
Do not commit, merge, integrate, deploy, promote, or expose this store through
gateway routes until a fresh independent audit returns `PASS` and the integrated
gate is green.
