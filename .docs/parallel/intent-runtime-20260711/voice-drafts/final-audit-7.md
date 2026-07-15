# Voice Draft Store Final Audit 7

## Disposition

`BLOCK`

The audit-6 implementation closes the concrete audit-5 examples covered by its
47-test suite: persisted objects and physical directories are exact, compacted
create/action retries return deterministic 410 outcomes, valid missing
mutations return 404, audio streams consume a verified immutable snapshot, and
malformed `sent_at` values fail before mutation. Syntax, the focused suite, and
the deterministic smoke all pass.

Fresh exported-API and restart probes found five release blockers. In
particular, compaction removes the independent claim/revision evidence needed to
validate a sent replay marker, nonterminal state/revision chains can be changed
without detection, recovery can be made impossible by the configured action-key
cap, owner-file durability failure strands a live lock, and expired outcomes
grow outside every configured record/byte ceiling.

No implementation, commit, merge, deployment, or live data was changed by this
audit.

## Passing Evidence

- `node --check gateway/lib/voice-drafts.js`: pass.
- `node --check gateway/test/voice-drafts.test.js`: pass.
- `node --check gateway/scripts/smoke-voice-drafts.js`: pass.
- `node --test gateway/test/voice-drafts.test.js`: 47 tests, 47 pass, 0 fail.
- `node gateway/scripts/smoke-voice-drafts.js`: `smoke-voice-drafts: ok`.
- `git diff --check`: pass.
- Per-untracked-file `git diff --no-index --check` produced no whitespace
  diagnostics. Its ordinary exit code is 1 because each file differs from
  `/dev/null`; that exit code is not a whitespace failure.
- The module imports only Node built-ins (`crypto`, `fs`, `path`, `stream`, and
  `util`). There is no provider, model, STT, LLM, TTS, tool, or network call in
  the store.
- The authored tests exercise every earlier audit-1 through audit-5 class,
  including real child-process lease exclusion, stale-lock ownership, append
  journals, cleanup markers, exact top/nested schemas, physical allowlists,
  configured lower limits, exact compacted create/action 410 outcomes before
  and after restart, valid missing 404 outcomes, digest/inode/directory/cleanup
  audio races, full-record sent authority, and strict `sent_at` input.
- `npm run check` was attempted. The old-base slice has no
  `gateway/node_modules`; it reported 186 pass, 50 fail, and 1 skip. The focused
  voice-draft tests passed inside the run. The other failures are environmental
  load/start failures such as missing `pg`, `ws`, `@executor-js/sdk`, and
  `livekit-server-sdk`, so the integrated tree still owes the full gate.

## Blocking Findings

### 1. Compacted sent replay authority can be changed without detection

Compaction retains the create request, terminal request/receipt, action hashes,
and expiry time, but drops the sent claim, claim request, final revision, and
terminal history (`gateway/lib/voice-drafts.js:1771-1794`). Expired-record
validation consequently checks request against receipt and creation authority,
but has no independent turn or revision anchor
(`gateway/lib/voice-drafts.js:1797-1856`). The full sent record has those exact
anchors (`gateway/lib/voice-drafts.js:3719-3750`); compaction removes them.

Exported-API/restart probe:

1. With `maxDrafts:1, maxTerminalDrafts:1`, create, append, send-ready, claim,
   and mark sent for A.
2. Create and discard B so A becomes `voice_draft_expired_replay`.
3. Change only A's `terminal_request.expected_revision` from 5 to 105.
4. Reopen the store. It accepts the marker and returns revision 105.
5. In a fresh fixture, change both `terminal_request.turn_id` and
   `terminal_receipt.turn_id` from `turn-a` to `forged-turn`.
6. Reopen the store. It accepts the marker and returns `forged-turn`.

This is not the unavoidable fact that a same-UID attacker can rewrite an entire
database coherently. Each mutation would fail against the full record because
the independent claim/final-revision evidence disagrees; it becomes
undetectable specifically because compaction discarded those anchors. The
expired-marker test checks unknown fields and content absence only
(`gateway/test/voice-drafts.test.js:1529-1571`), while the full-record sent
tamper matrix does not compact first
(`gateway/test/voice-drafts.test.js:2192-2242`).

Required repair:

- Preserve a minimal exact sent claim, claim request, final revision, and
  terminal-history authority in the compacted outcome, or preserve one
  cryptographically verifiable canonical decision digest in a separately
  authoritative replay index.
- Cross-bind session, branch, turn, actor, source, surface, release,
  `expected_revision`, claim revision, terminal revision, receipt, timestamp,
  and action hash after compaction.
- Add one-field and jointly coherent field-tamper regressions for both sent and
  discarded expired outcomes before and after restart. Evidence must remain
  byte-for-byte unchanged on rejection.

### 2. Nonterminal state, revision, and claim chains fail open

Transition-history normalization checks uniqueness, increasing request
revisions, and receipt-to-receipt chaining only inside the retained array
(`gateway/lib/voice-drafts.js:2524-2575`). The draft-level check merely requires
each retained request revision to be less than the draft revision
(`gateway/lib/voice-drafts.js:1501-1508`). Nonterminal state validation does not
require the last retained receipt's `state_after` to equal the current state,
does not bind the current revision to its last mutation, and does not bind a
send-ready claim request revision to the draft revision
(`gateway/lib/voice-drafts.js:3625-3711`; claim parsing at
`gateway/lib/voice-drafts.js:3211-3250`).

Three direct persisted-state/restart probes were accepted:

- A paused draft with revision 2 was changed to revision 102. Reopen returned
  paused revision 102 while its pause request still asserted revision 1.
- A paused draft was changed to `state:"capturing"` without changing its pause
  history, whose final receipt still asserted `state_after:"paused"`. Reopen
  returned capturing. That changes append authority, not merely display data.
- A claimed send-ready draft's `claim_request.expected_revision` was changed
  from 4 to 1. Reopen accepted the claim at draft revision 5.

Required repair:

- Bind the current state to the latest retained state transition and define an
  explicit initial/no-history rule. A paused history may never reopen as
  capturing.
- Persist enough last-mutation/revision authority to validate draft revision
  after history truncation. Bind append and claim revisions into that chain.
- Require a send-ready claim request to reference the exact pre-claim revision,
  and carry that invariant through sent and expired outcomes.
- Add paused/capturing, send-ready/claim, parked/recovery, appended-segment, and
  history-truncation tamper matrices.

### 3. Action-key exhaustion prevents required boot recovery

Boot recovery must turn an orphaned capturing/paused draft into parked state.
It records a normal `park` transition (`gateway/lib/voice-drafts.js:884-942`).
`rememberTransition()` reserves an over-cap entry only for discard and
mark-sent, not for the mandatory recovery park
(`gateway/lib/voice-drafts.js:2328-2344`).

Direct probe with `maxActionKeyHashes:2`:

1. Create, pause, and resume a draft, consuming both action hashes.
2. Remove the capture lease to simulate an orphaned capture after process
   death.
3. Reopen with the same limits.
4. Construction throws status 507, `voice draft durable idempotency capacity
   exceeded`; metadata is unchanged and the store never becomes available.

The authored capacity test stops after proving that a third user transition is
rejected (`gateway/test/voice-drafts.test.js:277-309`); it does not exercise the
required crash/restart recovery at capacity.

Required repair:

- Give the fixed boot-recovery decision a dedicated bounded replay slot or a
  separate system-recovery record that cannot be consumed by user actions.
- Reopen at exact action/history capacity, auto-park once, and replay the same
  recovery deterministically across subsequent restarts.
- Preserve the existing rule that capacity cannot be raised or history silently
  discarded merely to make recovery pass.

### 4. Owner-file directory-fsync failure strands live store and capture locks

`createOwnerFile()` removes the just-created owner only when writing or fsyncing
the file descriptor fails. The following parent-directory fsync is outside that
cleanup block (`gateway/lib/voice-drafts.js:2032-2050`). `withFileLock()` cannot
release it because acquisition is considered complete only after
`acquireOwnerFile()` returns (`gateway/lib/voice-drafts.js:1985-2007`). The same
primitive backs both operation locks and the process-wide capture lease.

Two one-shot `fs.fsyncSync` fault probes reproduced the failure:

- Failing the store-lock parent-directory fsync returned status 500 and left a
  complete `store.lock` naming the current PID/boot. The next create returned
  409 `voice-draft-store is locked by another live operation`.
- Allowing the store lock but failing the capture-lease parent-directory fsync
  returned status 500, left `capture.lock` for a draft whose directory was
  never created, made the next create return 409, and made a same-process store
  reopen return 500 `capture lease references missing or expired draft`.

Required repair:

- Treat owner creation as uncommitted until the directory durability step
  succeeds. On any post-create failure, compare-and-remove only the exact owner
  inode/owner ID, with a retryable recovery marker if cleanup itself cannot be
  durably confirmed.
- Recovery must recognize a lease whose authoritative draft was never
  published as an interrupted acquisition, not a live capture.
- Add separate store-lock and capture-lease directory-fsync failure regressions,
  followed by successful same-process retry and restart.

### 5. Expired replay outcomes bypass every configured count and byte ceiling

`maxDrafts` counts only nonterminal full records, and `maxTerminalDrafts` counts
only retained full terminal records (`gateway/lib/voice-drafts.js:1696-1717`).
Compaction converts excess records to expired directories but never caps or
indexes those directories (`gateway/lib/voice-drafts.js:1725-1768`).
`maxTotalBytes` accounts audio only and explicitly skips expired metadata during
preflight (`gateway/lib/voice-drafts.js:790-855`, especially 843-845), while
create replay scans and parses every authoritative record
(`gateway/lib/voice-drafts.js:2400-2425`). Preflight also retains every parsed
record in an in-memory array before its second phase (`gateway/lib/voice-drafts.js:790-834`).

Direct turnover probe with `maxDrafts:1`, `maxTerminalDrafts:1`, and
`maxTotalBytes:2`:

```text
20 create/discard cycles
status.count=20
capacity_count=0
terminal_replay_count=1
expired_replay_count=19
total_bytes=0
physical draft directories=20
metadata bytes=28,787
same-process reopen=236 ms
```

An authenticated caller can therefore create unbounded inode/disk growth and
linear startup/replay scans while every advertised quota remains green. This is
the known audit-6 residual promoted to a blocker by direct bounded-resource
testing; it is not safe to expose as the gateway's durable idempotency store.

Required repair:

- Move expired replay authority to a keyed transactional/event index with
  explicit partition, backup, restore, lookup, and resource policy before API
  exposure, or add an equivalently durable bounded on-disk index that can prove
  non-reuse without one directory/JSON parse per historical decision.
- Add configured total record, metadata-byte, and startup-work ceilings. Do not
  solve the problem by deleting the only replay authority and permitting key
  reuse.
- Add a many-turnover test that proves lookup does not scan/retain every
  historical outcome and that quota/status counts all physical metadata.

## Reproduced Audit-6 Guarantees

The following repair-6 requirements remain genuinely green and are not the
reason for this block:

- exact top-level and nested persisted field sets reject unknown fields without
  rewriting corrupt metadata;
- state-specific physical allowlists reject unexpected files, directories,
  symlinks, and malformed/oversized lock scaffolding before cleanup, after
  cleanup, and on restart;
- exact compacted create/action retries return durable 410 outcomes before and
  after restart, and valid missing mutations return 404 rather than a
  filesystem 500;
- `readBuffer()` and `createReadStream()` both validate size, digest, directory,
  and inode before returning any bytes. Same-size mutation, inode replacement,
  directory replacement, and cleanup during snapshot construction fail closed;
- duplicate/reordered transition hashes, nonmonotonic retained history, and all
  authored full-sent request/history/claim/receipt mismatches fail without
  rewriting evidence; and
- numeric, object, array, boolean, null, malformed, and merely parseable
  noncanonical `sent_at` values fail before mutation.

## Residual Integration Gates

- A verified audio snapshot is per-call bounded by configured
  `maxDraftBytes`, but it synchronously allocates the entire PCM file
  (`gateway/lib/voice-drafts.js:4274-4324`) and there is no aggregate live
  snapshot budget. Worker/streaming isolation and request-level concurrency
  policy remain required before high-volume integration.
- The store remains tenant-neutral. Authenticated gateway code must derive the
  tenant/session/branch/release namespace and never trust caller-selected
  cross-tenant authority.
- Portable Node filesystem checks do not provide native directory-FD
  `openat`/`renameat`/`unlinkat` protection against a hostile same-UID race.
- PID liveness for another process still cannot distinguish PID reuse from the
  original owner (`gateway/lib/voice-drafts.js:2295-2306`). A production lease
  needs process-start identity or a transactional store.
- `voice_draft_expired_replay` remains a rollout compatibility boundary: old
  code fails closed but cannot read it, so backup/restore and new-code-first
  staging are mandatory even after the blockers above are repaired.

## Re-Audit Gate

After repair, retain the existing 47 tests and add focused regressions for all
five findings above. Then run:

```sh
node --check gateway/lib/voice-drafts.js
node --check gateway/test/voice-drafts.test.js
node --check gateway/scripts/smoke-voice-drafts.js
node --test gateway/test/voice-drafts.test.js
node gateway/scripts/smoke-voice-drafts.js
git diff --check
```

The main orchestrator must also rerun the full gateway gate from the integrated
tree with dependencies installed. Do not commit, merge, integrate, deploy, or
promote this slice until a fresh audit returns `PASS`.
