# Voice Draft Store Repair Contract — Audit 4

## Disposition

`BLOCK`

The advertised syntax check, 29 focused tests, deterministic smoke, and
whitespace checks pass. The canonical terminal vocabulary is now correctly
`sent|discarded`, and the existing lock, cleanup-journal, authority, and
idempotency regressions are substantive. Independent adversarial probes still
found release blockers at the persisted-path/schema/resource boundaries and in
normal lifetime quota behavior.

This contract remains limited to `gateway/lib/voice-drafts.js`, its focused
tests/smoke, and this slice's documentation. Do not integrate it into the live
voice server in this repair lane.

## Passing Evidence

- `node --check gateway/lib/voice-drafts.js`: passed.
- `node --test gateway/test/voice-drafts.test.js`: 29 tests, 29 pass, 0 fail.
- `node gateway/scripts/smoke-voice-drafts.js`: `smoke-voice-drafts: ok`.
- `git diff --check`: passed, but the slice files are untracked, so the audit
  also ran `git diff --no-index --check /dev/null <file>` for every slice file;
  those checks passed.
- The store imports only Node `crypto`, `fs`, and `path`; pause, park, resume,
  discard, and send preparation contain no STT, LLM, TTS, provider, or tool
  call.
- `sent` is used consistently for the successful terminal state and cleanup /
  tombstone mode (`gateway/lib/voice-drafts.js:21,577-605,2432-2497`).

## Blocking Findings

### 1. Direct reads follow a symlinked draft directory outside the store

`draftDirForId()` only joins a validated name
(`gateway/lib/voice-drafts.js:962-965`). The direct `get`, `segments`, and
`readAudio` paths do not assert that this directory remains a non-symlink
boundary (`gateway/lib/voice-drafts.js:432-514`, `993-999`).
`openRegularFile()` checks the final entry and adds `O_NOFOLLOW`, but that does
not stop the OS from following a symlink in an intermediate directory
(`gateway/lib/voice-drafts.js:2601-2617`).

The audit created a valid parked draft, moved its directory outside
`voice-drafts`, replaced it with a directory symlink, and called the original
store instance. Both `get(draft.id)` and `readAudio(draft.id).readBuffer()`
succeeded and returned the outside PCM bytes. This violates the repair-2 rule
that every draft path boundary reject symlinks.

Required repair:

- Validate the store directory and the exact draft directory as non-symlink
  directories immediately before every metadata/audio/journal/lock read or
  open, including direct read helpers.
- Bind the opened file to the validated parent boundary. A final-component
  `O_NOFOLLOW` check alone is not sufficient for an intermediate symlink.
- A directory-symlink substitution must fail visibly for `get`, `list`,
  `segments`, `readAudio`, every mutation, recovery, and cleanup, without
  reading, writing, or deleting the outside target.

### 2. Persisted metadata is not fully bound to its container or required v2 authority

`loadOptionalDraft(draftsDir, requestedId)` normalizes `meta.json` but never
requires the stored `draft.id` to equal the containing/requested directory ID
(`gateway/lib/voice-drafts.js:993-999`). A focused probe changed `meta.id` and
the nested capture-lease draft ID; `store.get(originalDirectoryId)` returned
the different stored ID.

The durable v2 create request is optional on read
(`gateway/lib/voice-drafts.js:1045,1724-1727`). Removing `create_request` from a
valid parked draft was accepted across restart; retrying the same create
idempotency key created a second draft, because `findCreateResult()` can only
find surviving request records (`gateway/lib/voice-drafts.js:1707-1721`).

State validation checks only that the state name is in the transition table
(`gateway/lib/voice-drafts.js:1014-1016`). Sent receipt/request, cleanup marker,
and tombstone fields remain optional (`gateway/lib/voice-drafts.js:1046-1055`),
with no state-specific cross-field invariant. The audit changed a parked draft
with PCM to `state:"sent"`, left sent receipt/request/tombstone/cleanup null,
and restarted the store. Recovery accepted it as sent and left the raw audio
on disk. That is fail-open terminal privacy state.

Required repair:

- Require stored ID to equal the exact containing directory ID on every load.
- Require the canonical v2 `create_request` and its complete authority for
  every v2 draft. Missing create replay authority is corruption, not a
  compatibility fallback.
- Define and enforce state-specific persisted invariants. At minimum,
  `sent` requires canonical sent request/receipt and a matching sent tombstone;
  `discarded` requires its canonical discard receipt and discarded tombstone;
  terminal content must be absent after cleanup, or an exact matching
  `cleanup_pending` marker must make restart finish deletion before the record
  is exposed.
- Strictly validate parked/send-ready/discard/recovery receipt shapes instead
  of accepting arbitrary plain objects where those records decide recovery or
  authority.
- Corruption must fail without rewriting the source evidence or inventing a
  different draft path.

### 3. Persisted collections, text, and metadata files bypass configured bounds

`readJsonFile()` reads and parses an unbounded file synchronously
(`gateway/lib/voice-drafts.js:1307-1316`). Stored partial transcript text has no
length check (`gateway/lib/voice-drafts.js:1035,2247-2252`), and stored segment,
transition-history, and action-hash arrays are mapped without configured caps
(`gateway/lib/voice-drafts.js:1041-1043,1158-1183,1792-1857`). Recovery also
checks aggregate consistency but not configured maximum segment count, draft
bytes/duration, or metadata size.

The audit persisted a 100,000-character transcript and 1,000 valid unique
action hashes, then reopened with `maxPartialTranscriptChars:10` and
`maxActionKeyHashes:2`. Both values loaded successfully. This can happen after
a configuration reduction as well as corruption; it is not merely a malicious
filesystem scenario. Because startup scans all authoritative metadata
synchronously, an unbounded record can exhaust memory or stall the process
before the logical caps run.

Required repair:

- Bound metadata bytes before `JSON.parse`.
- Pass active limits into strict stored-schema validation and reject over-limit
  transcript length, segment/history/hash counts, per-draft bytes/duration,
  segment bytes/duration, and any other variable collection/text.
- Account explicitly for the one terminal replay record rather than treating
  terminal cleanup as permission for an unbounded action-hash array.
- Add regressions for both hand-crafted over-limit metadata and a restart after
  reopening data under lower configured limits. Failure must be deterministic
  and must not rewrite the record.

This is a release blocker, not ordinary performance debt: configured resource
policy currently ceases to apply at the persisted-state trust boundary.

### 4. Normal terminal use permanently exhausts `maxDrafts`

Create rejects when the number of authoritative metadata-bearing directories
reaches `maxDrafts` (`gateway/lib/voice-drafts.js:74-81`). Sent and discarded
tombstones remain authoritative forever, `listAuthoritativeDraftIds()` counts
them (`gateway/lib/voice-drafts.js:2853-2855`), and the public store seam has no
retention, compaction, or safe deletion operation
(`gateway/lib/voice-drafts.js:637-650`).

The audit configured `maxDrafts:2`, created and discarded two empty drafts, and
then received 507 for the third create even though total audio bytes were zero.
The default therefore stops all future capture after 128 lifetime drafts, not
128 active/content-bearing drafts.

Required repair:

- Define a bounded terminal-retention/compaction design that preserves privacy,
  exact create/action idempotency, and content-free receipts without making the
  draft directory quota a lifetime fuse.
- Do not silently delete active, parked, send-ready, cleanup-pending, or
  content-bearing records.
- Add a small-cap regression proving ordinary sent/discarded turnover permits a
  later create while exact retries of retained/compacted keys remain
  deterministic. If retention is intentionally operator-managed, provide a
  safe, tested store seam and a non-destructive status signal before API
  integration; manual filesystem deletion is not a recovery contract.

### 5. Mutation numeric fields are coerced instead of requiring JSON integers

`normalizeExpectedRevision()` and byte-count normalization call `Number(value)`
(`gateway/lib/voice-drafts.js:2076-2103`), while duration normalization also
rounds fractions (`gateway/lib/voice-drafts.js:2087-2093`). The audit
successfully paused with `expected_revision:"1"`, appended with
`byte_count:"2"` and another string revision, and had `duration_ms:1.4`
silently stored as `1`.

The domain contract requires integer expected revisions and exact declared
byte counts. Canonical idempotency cannot collapse invalid wire types or a
fractional duration into the same request as a valid integer.

Required repair:

- Require number-typed safe integers for expected revision, declared byte
  count, duration, and other integer mutation fields; reject numeric strings,
  fractions, unsafe integers, NaN, and infinity.
- Add create/action/append/claim/mark-sent regressions showing invalid numeric
  types fail before state, lease, history, or content changes.

## Required Adversarial Regressions

1. Replace a draft directory with a symlink to an outside valid draft; every
   direct read, mutation, recovery, and cleanup path rejects it and leaves the
   target untouched.
2. Make stored ID disagree with its directory, remove `create_request`, and
   construct terminal states missing or disagreeing with receipts/tombstones /
   cleanup markers. Each fails visibly without rewrite or duplicate create.
3. Load over-limit metadata bytes, transcript text, segments, history, hashes,
   draft totals, and per-segment totals, including after lowering configured
   limits.
4. Exercise terminal turnover under a tiny draft cap without losing replay
   protection or deleting content-bearing records.
5. Reject string/fractional/unsafe numeric mutation fields and prove the draft
   and filesystem are unchanged.

Keep the existing 29 regressions. Do not replace real process/lock tests with
mocks, raise limits to make failures disappear, delete corruption assertions,
or weaken exact replay comparisons.

## Assessed Non-Blocking Debt

- **Read/mutation races:** reads do not retain the mutation lock, but metadata
  replacement is atomic, `readBuffer()` checks size and digest, and the stream
  path checks size then fixes its end offset. Concurrent append/cleanup can
  produce a transient fail-closed error or a valid old append-only prefix, not
  silently return a different claimed snapshot. The API seam must document
  retry/snapshot behavior and the fact that an already-open file descriptor
  cannot be revoked by later discard. This remains integration debt, not an
  additional slice blocker.
- **Synchronous hashing/full-file reads:** current default hard audio caps bound
  the work, but repeated append hashing is potentially quadratic and can block
  the gateway event loop. Move it to a worker/streaming design before
  high-volume API exposure; it does not independently block this isolated
  synchronous store once persisted bounds are enforced.
- **Single 2.8k-line module:** splitting schema validation, filesystem safety,
  locks/recovery, and domain transitions would reduce maintenance risk. The
  current module is cohesive and its size alone is not a release blocker.
- **Tenant authorization:** the store has no authenticated tenant namespace.
  That remains an explicit gateway/API integration requirement; do not expose
  caller-supplied session/branch/draft IDs directly.
- **Other-PID reuse:** the real child-process recovery tests pass and the
  current-PID/different-boot case is fixed. Robust cross-host/process identity
  evidence should be revisited if this file lock is used beyond one host.

## Verification Gate After Repair

```sh
node --check gateway/lib/voice-drafts.js
node --test gateway/test/voice-drafts.test.js
node gateway/scripts/smoke-voice-drafts.js
git diff --check
```

Because the slice files are currently untracked, also run a non-index
whitespace check over each changed/new file or stage them only in the main
orchestrator's eventual commit workflow. Do not commit, merge, integrate, or
deploy in this audit lane.
